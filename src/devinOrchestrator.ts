import {
  AlertBatch,
  DevinSession,
  DevinStructuredOutput,
  SessionStatus,
  RemediationRun,
} from './types';

const DEVIN_API_BASE = 'https://api.devin.ai/v1';

export class DevinOrchestrator {
  private apiKey: string;
  private maxParallelSessions: number;
  private activeSessions: Map<string, DevinSession> = new Map();
  private repository: string;

  constructor(apiKey: string, maxParallelSessions: number, repository: string) {
    this.apiKey = apiKey;
    this.maxParallelSessions = maxParallelSessions;
    this.repository = repository;
  }

  async processBatches(
    batches: AlertBatch[],
    onProgress: (batch: AlertBatch, session: DevinSession) => void | Promise<void>,
    onComplete: (batch: AlertBatch, session: DevinSession) => void | Promise<void>,
    checkPaused: () => boolean | Promise<boolean>
  ): Promise<Map<string, DevinSession>> {
    const pendingBatches = [...batches].filter(b => b.status === 'pending');
    const completedSessions = new Map<string, DevinSession>();

    while (pendingBatches.length > 0 || this.activeSessions.size > 0) {
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
          batch.status = 'in_progress';
          batch.sessionId = session.sessionId;
          batch.sessionUrl = session.url;
          batch.startedAt = new Date().toISOString();
        }
      }

      for (const [batchId, session] of this.activeSessions.entries()) {
        const batch = batches.find(b => b.id === batchId)!;
        const updatedSession = await this.pollSession(session.sessionId);
        
        if (updatedSession) {
          this.activeSessions.set(batchId, updatedSession);
          await onProgress(batch, updatedSession);

          if (this.isSessionComplete(updatedSession.status)) {
            batch.status = updatedSession.status === 'stopped' ? 'completed' : 'failed';
            batch.completedAt = new Date().toISOString();
            
            if (updatedSession.structuredOutput?.prUrl) {
              batch.prUrl = updatedSession.structuredOutput.prUrl;
            }
            
            if (updatedSession.structuredOutput?.confidenceScore) {
              batch.confidenceScore = updatedSession.structuredOutput.confidenceScore;
            }

            completedSessions.set(batchId, updatedSession);
            this.activeSessions.delete(batchId);
            await onComplete(batch, updatedSession);
          }
        }
      }

      await this.sleep(10000);
    }

    return completedSessions;
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

      if (!response.ok) {
        const error = await response.text();
        console.error(`Failed to create session for batch ${batch.id}:`, error);
        return null;
      }

      const data = await response.json() as { session_id: string; url: string };
      
      return {
        sessionId: data.session_id,
        url: data.url,
        status: 'running' as SessionStatus,
        batchId: batch.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
      };
    } catch (error) {
      console.error(`Error creating session for batch ${batch.id}:`, error);
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
  "confidenceExplanation": "<string>"
}
`;

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

## Instructions

1. **Clone the repository** and create a new branch named \`fix/codeql-${batch.groupKey}-${Date.now()}\`

2. **For each alert**, analyze the vulnerability and implement a secure fix:
   - Understand the root cause of the vulnerability
   - Implement a fix that addresses the security issue without breaking functionality
   - Ensure the fix follows security best practices
   - Add comments explaining the security fix if helpful

3. **Test your changes**:
   - Run any existing tests to ensure you haven't broken functionality
   - If possible, verify the CodeQL alert would be resolved

4. **Create a Pull Request** with:
   - A clear title mentioning the CWE/vulnerability type
   - A detailed description of each fix
   - References to the original CodeQL alerts

5. **Update structured output** after each significant step using this schema:
${structuredOutputSchema}

## Confidence Scoring Guidelines

When assessing your confidence score (0.0-1.0), consider:
- **0.9-1.0**: Simple, well-understood fix with clear security pattern
- **0.7-0.9**: Standard fix with good understanding, minor uncertainty
- **0.5-0.7**: Fix implemented but some uncertainty about edge cases
- **0.3-0.5**: Significant uncertainty, may need human review
- **0.0-0.3**: Low confidence, complex issue or unclear solution

Please update the structured output immediately after:
- Starting work on each alert
- Completing each fix
- Running tests
- Creating the PR

Begin by cloning the repository and analyzing the first alert.
`;
  }

  private mapStatus(status: string): SessionStatus {
    switch (status?.toLowerCase()) {
      case 'running':
        return 'running';
      case 'blocked':
        return 'blocked';
      case 'stopped':
        return 'stopped';
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      default:
        return 'pending';
    }
  }

  private isSessionComplete(status: SessionStatus): boolean {
    return ['stopped', 'completed', 'failed'].includes(status);
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
