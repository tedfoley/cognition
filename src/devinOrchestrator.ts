import { Octokit } from '@octokit/rest';
import {
  AlertBatch,
  DevinSession,
  DevinStructuredOutput,
  SessionStatus,
  RemediationRun,
  ConfidenceSignals,
} from './types';
import { PRGenerator } from './prGenerator';

const DEVIN_API_BASE = 'https://api.devin.ai/v1';

// Polling configuration with exponential backoff
const INITIAL_POLL_INTERVAL_MS = 10000;  // 10 seconds
const MAX_POLL_INTERVAL_MS = 60000;      // 1 minute max
const BACKOFF_MULTIPLIER = 1.5;
const MAX_POLL_RETRIES = 5;              // Max consecutive failures before giving up
const MAX_TOTAL_POLL_TIME_MS = 3600000;  // 1 hour max total polling time
const MAX_BATCH_TIME_MS = 1800000;       // 30 minutes max per batch

// Devin API response interfaces
interface DevinCreateSessionResponse {
  session_id: string;
  url: string;
  is_new_session?: boolean;
}

interface DevinSessionResponse {
  session_id: string;
  status: string;
  status_enum: SessionStatus;
  created_at: string;
  updated_at: string;
  messages?: Array<{ role: string; content: string; timestamp?: string }>;
  structured_output?: DevinStructuredOutput;
  pull_request?: { url: string };
  title?: string;
}

export class DevinOrchestrator {
  private apiKey: string;
  private maxParallelSessions: number;
  private activeSessions: Map<string, DevinSession> = new Map();
  private repository: string;
  private octokit: Octokit;
  private prGenerator: PRGenerator;
  private pollRetries: Map<string, number> = new Map();
  private pollIntervals: Map<string, number> = new Map();
  private batchStartTimes: Map<string, number> = new Map();

  constructor(apiKey: string, maxParallelSessions: number, repository: string, githubToken: string) {
    this.apiKey = apiKey;
    this.maxParallelSessions = maxParallelSessions;
    this.repository = repository;
    this.octokit = new Octokit({ auth: githubToken });
    this.prGenerator = new PRGenerator(repository);
  }

  async processBatches(
    batches: AlertBatch[],
    onProgress: (batch: AlertBatch, session: DevinSession) => void | Promise<void>,
    onComplete: (batch: AlertBatch, session: DevinSession, confidenceSignals?: ConfidenceSignals) => void | Promise<void>,
    checkPaused: () => boolean | Promise<boolean>
  ): Promise<Map<string, DevinSession>> {
    const pendingBatches = [...batches].filter(b => b.status === 'pending');
    const completedSessions = new Map<string, DevinSession>();
    const startTime = Date.now();

    while (pendingBatches.length > 0 || this.activeSessions.size > 0) {
      // Check for max total polling time
      if (Date.now() - startTime > MAX_TOTAL_POLL_TIME_MS) {
        console.error('Max total polling time exceeded, stopping orchestrator');
        break;
      }

      if (await checkPaused()) {
        console.log('Orchestrator paused, waiting...');
        await this.sleep(5000);
        continue;
      }

      while (
        this.activeSessions.size < this.maxParallelSessions &&
        pendingBatches.length > 0
      ) {
        const batch = pendingBatches.shift()!;
        const session = await this.startSession(batch);
        
        if (session) {
          this.activeSessions.set(batch.id, session);
          this.pollRetries.set(batch.id, 0);
          this.pollIntervals.set(batch.id, INITIAL_POLL_INTERVAL_MS);
          this.batchStartTimes.set(batch.id, Date.now());
          batch.status = 'in_progress';
          batch.sessionId = session.sessionId;
          batch.sessionUrl = session.url;
          batch.startedAt = new Date().toISOString();
        }
      }

      for (const [batchId, session] of this.activeSessions.entries()) {
        const batch = batches.find(b => b.id === batchId)!;
        
        // Check for per-batch timeout
        const batchStartTime = this.batchStartTimes.get(batchId) || Date.now();
        if (Date.now() - batchStartTime > MAX_BATCH_TIME_MS) {
          console.error(`Batch ${batchId} exceeded max time (${MAX_BATCH_TIME_MS / 60000} minutes), marking as failed`);
          batch.status = 'failed';
          batch.completedAt = new Date().toISOString();
          this.activeSessions.delete(batchId);
          this.pollRetries.delete(batchId);
          this.pollIntervals.delete(batchId);
          this.batchStartTimes.delete(batchId);
          await onComplete(batch, session);
          continue;
        }
        
        const updatedSession = await this.pollSessionWithBackoff(session.sessionId, batchId);
        
        if (updatedSession) {
          // Reset retry count on successful poll
          this.pollRetries.set(batchId, 0);
          this.activeSessions.set(batchId, updatedSession);
          await onProgress(batch, updatedSession);

          // Check for completion: either session status is complete OR progress=100 with prUrl
          const isStatusComplete = this.isSessionComplete(updatedSession.status);
          const isProgressComplete = updatedSession.structuredOutput?.progress === 100 && 
            (updatedSession.prUrl || updatedSession.structuredOutput?.prUrl);
          
          if (isStatusComplete || isProgressComplete) {
            if (isProgressComplete && !isStatusComplete) {
              console.log(`Batch ${batchId} completed via progress=100 with prUrl (status was: ${updatedSession.status})`);
            }
            // If completed via progress=100 with prUrl, mark as completed regardless of status
            batch.status = isProgressComplete ? 'completed' : (updatedSession.status === 'finished' ? 'completed' : 'failed');
            batch.completedAt = new Date().toISOString();
            
            // Get PR URL from API response (pull_request.url) or structured output
            if (updatedSession.prUrl) {
              batch.prUrl = updatedSession.prUrl;
              // Update PR description with rich format
              await this.updatePRDescription(batch, updatedSession);
            } else if (updatedSession.structuredOutput?.prUrl) {
              batch.prUrl = updatedSession.structuredOutput.prUrl;
              await this.updatePRDescription(batch, updatedSession);
            }
            
            if (updatedSession.structuredOutput?.confidenceScore) {
              batch.confidenceScore = updatedSession.structuredOutput.confidenceScore;
            }

            completedSessions.set(batchId, updatedSession);
            this.activeSessions.delete(batchId);
            this.pollRetries.delete(batchId);
            this.pollIntervals.delete(batchId);
            this.batchStartTimes.delete(batchId);
            await onComplete(batch, updatedSession);
          }
        } else {
          // Handle poll failure with retry logic
          const retries = (this.pollRetries.get(batchId) || 0) + 1;
          this.pollRetries.set(batchId, retries);
          
          if (retries >= MAX_POLL_RETRIES) {
            console.error(`Max retries exceeded for batch ${batchId}, marking as failed`);
            batch.status = 'failed';
            batch.completedAt = new Date().toISOString();
            this.activeSessions.delete(batchId);
            this.pollRetries.delete(batchId);
            this.pollIntervals.delete(batchId);
            this.batchStartTimes.delete(batchId);
            await onComplete(batch, session);
          } else {
            // Increase poll interval with exponential backoff
            const currentInterval = this.pollIntervals.get(batchId) || INITIAL_POLL_INTERVAL_MS;
            const newInterval = Math.min(currentInterval * BACKOFF_MULTIPLIER, MAX_POLL_INTERVAL_MS);
            this.pollIntervals.set(batchId, newInterval);
            console.log(`Poll failed for batch ${batchId}, retry ${retries}/${MAX_POLL_RETRIES}, next interval: ${newInterval}ms`);
          }
        }
      }

      // Use the minimum poll interval among active sessions
      const minInterval = Math.min(
        ...Array.from(this.pollIntervals.values()),
        INITIAL_POLL_INTERVAL_MS
      );
      await this.sleep(minInterval);
    }

    return completedSessions;
  }

  private async updatePRDescription(batch: AlertBatch, session: DevinSession): Promise<void> {
    const prUrl = session.prUrl || session.structuredOutput?.prUrl;
    if (!prUrl) return;

    const prNumber = this.extractPRNumber(prUrl);
    if (!prNumber) return;

    try {
      const [owner, repo] = this.repository.split('/');
      const prDescription = this.prGenerator.generatePRDescription(
        batch,
        session.structuredOutput,
        undefined, // confidenceSignals will be calculated by the caller
        session.url
      );

      await this.octokit.pulls.update({
        owner,
        repo,
        pull_number: prNumber,
        title: prDescription.title,
        body: prDescription.body,
      });

      // Add labels to the PR
      if (prDescription.labels.length > 0) {
        await this.octokit.issues.addLabels({
          owner,
          repo,
          issue_number: prNumber,
          labels: prDescription.labels,
        });
      }

      console.log(`Updated PR #${prNumber} with rich description`);
    } catch (error) {
      console.error(`Failed to update PR description:`, error);
    }
  }

  private extractPRNumber(prUrl: string): number | null {
    const match = prUrl.match(/\/pull\/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  async startSession(batch: AlertBatch): Promise<DevinSession | null> {
    const prompt = this.buildPrompt(batch);
    
    try {
      const response = await fetch(`${DEVIN_API_BASE}/sessions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt,
          title: `CodeQL Fix: ${batch.groupKey}`,
          tags: ['codeql-remediation', batch.severity, batch.groupKey],
        }),
      });

      // Handle specific error cases
      if (!response.ok) {
        const errorText = await response.text();
        
        if (response.status === 401) {
          console.error(`Authentication failed for Devin API. Please check your DEVIN_API_KEY.`);
          throw new Error('Devin API authentication failed');
        }
        
        if (response.status === 429) {
          console.error(`Rate limit exceeded for Devin API. Waiting before retry...`);
          // Wait 60 seconds before allowing retry
          await this.sleep(60000);
          return null;
        }
        
        if (response.status === 403) {
          console.error(`Access forbidden. Check API key permissions.`);
          throw new Error('Devin API access forbidden');
        }
        
        console.error(`Failed to create session for batch ${batch.id}: ${response.status} - ${errorText}`);
        return null;
      }

      const data = await response.json() as DevinCreateSessionResponse;
      
      return {
        sessionId: data.session_id,
        url: data.url,
        status: 'working' as SessionStatus,
        batchId: batch.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
      };
    } catch (error) {
      if (error instanceof Error && (error.message.includes('authentication') || error.message.includes('forbidden'))) {
        throw error; // Re-throw auth errors to stop the orchestrator
      }
      console.error(`Error creating session for batch ${batch.id}:`, error);
      return null;
    }
  }

  private async pollSessionWithBackoff(sessionId: string, batchId: string): Promise<DevinSession | null> {
    const currentInterval = this.pollIntervals.get(batchId) || INITIAL_POLL_INTERVAL_MS;
    
    try {
      const response = await fetch(`${DEVIN_API_BASE}/sessions/${sessionId}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      // Handle rate limiting with exponential backoff
      if (response.status === 429) {
        console.warn(`Rate limited when polling session ${sessionId}, backing off...`);
        const newInterval = Math.min(currentInterval * BACKOFF_MULTIPLIER * 2, MAX_POLL_INTERVAL_MS);
        this.pollIntervals.set(batchId, newInterval);
        return null;
      }

      if (response.status === 401) {
        console.error(`Authentication failed when polling session ${sessionId}`);
        throw new Error('Devin API authentication failed');
      }

      if (!response.ok) {
        console.error(`Failed to poll session ${sessionId}: ${response.status}`);
        return null;
      }

      const data = await response.json() as DevinSessionResponse;
      
      // Log actual status values for debugging
      console.log(`Session ${sessionId} status: ${data.status}, status_enum: ${data.status_enum}, progress: ${data.structured_output?.progress || 0}%`);
      
      // Reset interval on successful poll
      this.pollIntervals.set(batchId, INITIAL_POLL_INTERVAL_MS);
      
      return {
        sessionId: data.session_id,
        url: `https://app.devin.ai/sessions/${sessionId}`,
        status: data.status_enum || this.mapStatus(data.status),
        batchId: batchId,
        structuredOutput: data.structured_output,
        prUrl: data.pull_request?.url,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        messages: (data.messages || []).map(m => ({
          role: m.role as 'user' | 'devin',
          content: m.content,
          timestamp: m.timestamp || new Date().toISOString(),
        })),
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('authentication')) {
        throw error;
      }
      console.error(`Error polling session ${sessionId}:`, error);
      return null;
    }
  }

  async pollSession(sessionId: string): Promise<DevinSession | null> {
    try {
      const response = await fetch(`${DEVIN_API_BASE}/sessions/${sessionId}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        console.error(`Failed to poll session ${sessionId}`);
        return null;
      }

      interface DevinAPIResponse {
        session_id: string;
        url?: string;
        status_enum: string;
        structured_output?: DevinStructuredOutput;
        created_at: string;
        updated_at: string;
        messages?: DevinSession['messages'];
      }
      
      const data = await response.json() as DevinAPIResponse;
      
      return {
        sessionId: data.session_id,
        url: data.url || `https://app.devin.ai/sessions/${sessionId}`,
        status: this.mapStatus(data.status_enum),
        batchId: '',
        structuredOutput: data.structured_output,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        messages: data.messages || [],
      };
    } catch (error) {
      console.error(`Error polling session ${sessionId}:`, error);
      return null;
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<boolean> {
    try {
      const response = await fetch(`${DEVIN_API_BASE}/sessions/${sessionId}/message`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message }),
      });

      return response.ok;
    } catch (error) {
      console.error(`Error sending message to session ${sessionId}:`, error);
      return false;
    }
  }

  async terminateSession(sessionId: string): Promise<boolean> {
    try {
      const response = await fetch(`${DEVIN_API_BASE}/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      return response.ok;
    } catch (error) {
      console.error(`Error terminating session ${sessionId}:`, error);
      return false;
    }
  }

  private buildPrompt(batch: AlertBatch): string {
    const alertDescriptions = batch.alerts.map((alert, index) => {
      return `
### Alert ${index + 1}: ${alert.rule.name}
- **Alert Number**: #${alert.number}
- **Severity**: ${alert.rule.severity}
- **CWE**: ${alert.cwe?.join(', ') || 'N/A'}
- **File**: ${alert.most_recent_instance.location.path}
- **Lines**: ${alert.most_recent_instance.location.start_line}-${alert.most_recent_instance.location.end_line}
- **Description**: ${alert.rule.description}
- **Message**: ${alert.most_recent_instance.message.text}
- **URL**: ${alert.html_url}
`;
    }).join('\n');

    const structuredOutputSchema = `
{
  "fixes": [
    {
      "alertNumber": <number>,
      "status": "pending" | "in_progress" | "completed" | "failed",
      "filePath": "<string>",
      "originalCode": "<string>",
      "fixedCode": "<string>",
      "explanation": "<string>",
      "confidenceScore": <0.0-1.0>,
      "testsPassed": <boolean>
    }
  ],
  "currentTask": "<string>",
  "progress": <0-100>,
  "prUrl": "<string or null>",
  "confidenceScore": <0.0-1.0>,
  "confidenceExplanation": "<string>",
  "checklist": {
    "repositoryCloned": <boolean>,
    "branchCreated": <boolean>,
    "alertsAnalyzed": <number>,
    "alertsFixed": <number>,
    "testsRun": <boolean>,
    "testsPassed": <boolean>,
    "prCreated": <boolean>
  }
}
`;

    // Generate alert checklist items
    const alertChecklist = batch.alerts.map((alert, index) => 
      `- [ ] Alert ${index + 1} (#${alert.number}): ${alert.rule.name} - analyzed and fixed`
    ).join('\n');

    return `
# CodeQL Security Vulnerability Remediation

You are tasked with fixing ${batch.alerts.length} CodeQL security vulnerabilities in the repository: ${this.repository}

## Batch Information
- **Batch ID**: ${batch.id}
- **Group**: ${batch.groupKey}
- **Severity**: ${batch.severity}
- **Strategy**: ${batch.strategy}

## Alerts to Fix
${alertDescriptions}

---

## Step-by-Step Instructions

### Step 1: Repository Setup
**Success Criteria**: Repository cloned and new branch created

1.1. Clone the repository: \`${this.repository}\`
1.2. Create a new branch named: \`fix/codeql-${batch.groupKey}-${Date.now()}\`
1.3. Update structured output with \`checklist.repositoryCloned: true\` and \`checklist.branchCreated: true\`

### Step 2: Analyze Vulnerabilities
**Success Criteria**: All ${batch.alerts.length} alerts understood with fix strategy identified

For each alert:
2.1. Read the affected file and understand the code context
2.2. Identify the root cause of the vulnerability
2.3. Plan the fix approach following security best practices
2.4. Update structured output: increment \`checklist.alertsAnalyzed\`

### Step 3: Implement Fixes
**Success Criteria**: All alerts fixed with secure code patterns

For each alert:
3.1. Implement the security fix
3.2. Ensure the fix doesn't break existing functionality
3.3. Add inline comments if the fix is non-obvious
3.4. Update structured output: 
     - Set fix status to "completed"
     - Include originalCode and fixedCode
     - Increment \`checklist.alertsFixed\`
     - Update \`progress\` percentage

### Step 4: Run Tests
**Success Criteria**: All existing tests pass

4.1. Run the project's test suite (npm test, pytest, etc.)
4.2. If tests fail, investigate and fix without breaking security fixes
4.3. Update structured output: \`checklist.testsRun: true\`, \`checklist.testsPassed: true/false\`

### Step 5: Create Pull Request
**Success Criteria**: PR created with clear description

5.1. Commit all changes with message: "fix(security): resolve ${batch.alerts.length} CodeQL alerts for ${batch.groupKey}"
5.2. Push the branch to origin
5.3. Create a Pull Request with:
     - Title mentioning the vulnerability type and count
     - Description listing each fixed alert
     - References to CWE numbers
5.4. Update structured output: \`prUrl\`, \`checklist.prCreated: true\`, \`progress: 100\`

---

## Structured Output Schema
Update this after EVERY significant action:
${structuredOutputSchema}

## Confidence Scoring Guidelines

When assessing your confidence score (0.0-1.0), consider:
- **0.9-1.0**: Simple, well-understood fix with clear security pattern
- **0.7-0.9**: Standard fix with good understanding, minor uncertainty
- **0.5-0.7**: Fix implemented but some uncertainty about edge cases
- **0.3-0.5**: Significant uncertainty, may need human review
- **0.0-0.3**: Low confidence, complex issue or unclear solution

---

## Checklist (update structured output after each step)

- [ ] Repository cloned and branch created
${alertChecklist}
- [ ] Tests run and passing
- [ ] PR created with description

---

Begin with Step 1: Clone the repository and create a new branch.
`;
  }

  private mapStatus(status: string): SessionStatus {
    // Map Devin API status values to our SessionStatus type
    switch (status?.toLowerCase()) {
      case 'working':
        return 'working';
      case 'blocked':
        return 'blocked';
      case 'finished':
        return 'finished';
      case 'expired':
        return 'expired';
      case 'suspend_requested':
      case 'suspend_requested_frontend':
      case 'suspended':
        return 'suspended';
      case 'resume_requested':
      case 'resume_requested_frontend':
      case 'resumed':
        return 'resumed';
      default:
        return 'pending';
    }
  }

  private isSessionComplete(status: SessionStatus): boolean {
    // Session is complete when finished, expired, or suspended
    return ['finished', 'expired', 'suspended'].includes(status);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getActiveSessions(): DevinSession[] {
    return Array.from(this.activeSessions.values());
  }

  getActiveSessionCount(): number {
    return this.activeSessions.size;
  }
}
