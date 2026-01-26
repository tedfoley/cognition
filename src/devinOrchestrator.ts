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

// Rate limiting and session management
const SESSION_START_DELAY_MS = 30000;    // 30 seconds between session starts
const RATE_LIMIT_WAIT_MS = 60000;        // 60 seconds wait when rate limited
const MAX_CONCURRENT_SESSIONS = 5;       // Devin's concurrent session limit
const WAIT_FOR_SLOT_POLL_MS = 5000;      // 5 seconds between slot availability checks

// CI check configuration
const MAX_CI_ATTEMPTS = 2;               // Allow Devin 2 attempts to fix CI failures
const CI_POLL_INTERVAL_MS = 30000;       // Check CI status every 30 seconds
const CI_TIMEOUT_MS = 600000;            // 10 minute timeout waiting for CI

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

interface StartSessionResult {
  session: DevinSession | null;
  rateLimited: boolean;
  sessionLimitHit: boolean;
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
  private lastSessionStartTime: number = 0;
  private rateLimitHits: number = 0;

  constructor(apiKey: string, maxParallelSessions: number, repository: string, githubToken: string) {
    this.apiKey = apiKey;
    // Use the smaller of configured max and conservative limit to avoid hitting Devin's session limit
    this.maxParallelSessions = Math.min(maxParallelSessions, MAX_CONCURRENT_SESSIONS - 1);
    this.repository = repository;
    this.octokit = new Octokit({ auth: githubToken });
    this.prGenerator = new PRGenerator(repository);
    console.log(`[Orchestrator] Initialized with maxParallelSessions=${this.maxParallelSessions} (configured: ${maxParallelSessions}, limit: ${MAX_CONCURRENT_SESSIONS})`);
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

    console.log(`[Orchestrator] Starting with ${pendingBatches.length} pending batches, maxParallelSessions=${this.maxParallelSessions}`);
    
    while (pendingBatches.length > 0 || this.activeSessions.size > 0) {
      console.log(`[Orchestrator] Loop iteration: pendingBatches=${pendingBatches.length}, activeSessions=${this.activeSessions.size}`);
      
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

      // Start new sessions if we have capacity
      while (
        this.activeSessions.size < this.maxParallelSessions &&
        pendingBatches.length > 0
      ) {
        // Enforce delay between session starts to avoid rate limiting
        const timeSinceLastStart = Date.now() - this.lastSessionStartTime;
        if (this.lastSessionStartTime > 0 && timeSinceLastStart < SESSION_START_DELAY_MS) {
          const waitTime = SESSION_START_DELAY_MS - timeSinceLastStart;
          console.log(`[Orchestrator] Waiting ${waitTime}ms before starting next session (rate limit prevention)`);
          await this.sleep(waitTime);
        }

        console.log(`[Orchestrator] Starting new session: activeSessions=${this.activeSessions.size} < maxParallel=${this.maxParallelSessions}, pendingBatches=${pendingBatches.length}`);
        const batch = pendingBatches.shift()!;
        console.log(`[Orchestrator] Starting batch ${batch.id} (${batch.groupKey})`);
        const result = await this.startSessionWithRetry(batch);
        
        if (result.rateLimited || result.sessionLimitHit) {
          // Re-queue the batch instead of failing
          pendingBatches.unshift(batch);
          console.log(`[Orchestrator] Re-queued batch ${batch.id} due to ${result.rateLimited ? 'rate limiting' : 'session limit'}`);
          this.rateLimitHits++;
          
          // If we've hit rate limits multiple times, reduce parallel sessions
          if (this.rateLimitHits >= 3 && this.maxParallelSessions > 1) {
            this.maxParallelSessions--;
            console.log(`[Orchestrator] Reduced maxParallelSessions to ${this.maxParallelSessions} due to repeated rate limits`);
          }
          
          // Break out of the inner loop to let existing sessions progress
          break;
        } else if (result.session) {
          this.activeSessions.set(batch.id, result.session);
          this.pollRetries.set(batch.id, 0);
          this.pollIntervals.set(batch.id, INITIAL_POLL_INTERVAL_MS);
          this.batchStartTimes.set(batch.id, Date.now());
          this.lastSessionStartTime = Date.now();
          batch.status = 'in_progress';
          batch.sessionId = result.session.sessionId;
          batch.sessionUrl = result.session.url;
          batch.startedAt = new Date().toISOString();
          console.log(`[Orchestrator] Added batch ${batch.id} to activeSessions. Active count: ${this.activeSessions.size}`);
          
          // Publish immediately so dashboard shows "in progress" status
          await onProgress(batch, result.session);
        } else {
          console.log(`[Orchestrator] Failed to start session for batch ${batch.id}, will not re-queue`);
        }
      }

      // Collect batch IDs to process (avoid modifying map while iterating)
      const batchIdsToProcess = Array.from(this.activeSessions.keys());
      console.log(`[Orchestrator] Processing ${batchIdsToProcess.length} active sessions`);
      
      for (const batchId of batchIdsToProcess) {
        const session = this.activeSessions.get(batchId);
        if (!session) continue;
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
          
          // Explicitly terminate the timed-out session to free up the session slot
          await this.cleanupSession(session.sessionId, batchId);
          
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
            
            // Get PR URL from API response (pull_request.url) or structured output
            const prUrl = updatedSession.prUrl || updatedSession.structuredOutput?.prUrl;
            if (prUrl) {
              batch.prUrl = prUrl;
              // Update PR description with rich format
              await this.updatePRDescription(batch, updatedSession);
              
              // Wait for CI checks to pass before terminating the session
              // This allows Devin to fix CI failures if they occur
              const ciPassed = await this.waitForCIChecks(prUrl, updatedSession.sessionId);
              
              if (ciPassed) {
                console.log(`[Orchestrator] CI passed for batch ${batchId}, marking as completed`);
                batch.status = 'completed';
              } else {
                console.log(`[Orchestrator] CI failed or timed out for batch ${batchId} after max attempts`);
                // Still mark as completed since PR was created, but CI didn't pass
                batch.status = isProgressComplete ? 'completed' : (updatedSession.status === 'finished' ? 'completed' : 'failed');
              }
            } else {
              // No PR URL, use original status logic
              batch.status = isProgressComplete ? 'completed' : (updatedSession.status === 'finished' ? 'completed' : 'failed');
            }
            
            batch.completedAt = new Date().toISOString();
            
            if (updatedSession.structuredOutput?.confidenceScore) {
              batch.confidenceScore = updatedSession.structuredOutput.confidenceScore;
            }

            completedSessions.set(batchId, updatedSession);
            this.activeSessions.delete(batchId);
            this.pollRetries.delete(batchId);
            this.pollIntervals.delete(batchId);
            this.batchStartTimes.delete(batchId);
            
            // Explicitly terminate the session to free up the session slot
            // This now happens AFTER CI checking is complete
            await this.cleanupSession(updatedSession.sessionId, batchId);
            
            console.log(`[Orchestrator] Batch ${batchId} completed. Removed from activeSessions. Active count: ${this.activeSessions.size}, Pending: ${pendingBatches.length}`);
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
            
            // Explicitly terminate the failed session to free up the session slot
            await this.cleanupSession(session.sessionId, batchId);
            
            console.log(`[Orchestrator] Batch ${batchId} failed (max retries). Removed from activeSessions. Active count: ${this.activeSessions.size}, Pending: ${pendingBatches.length}`);
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

  private async startSessionWithRetry(batch: AlertBatch): Promise<StartSessionResult> {
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
          console.warn(`Rate limited when starting batch ${batch.id}. Will re-queue.`);
          await this.sleep(RATE_LIMIT_WAIT_MS);
          return { session: null, rateLimited: true, sessionLimitHit: false };
        }
        
        // Check for concurrent session limit error
        if (response.status === 400 || response.status === 403) {
          const lowerError = errorText.toLowerCase();
          if (lowerError.includes('concurrent session limit') || lowerError.includes('session limit')) {
            console.warn(`Concurrent session limit hit when starting batch ${batch.id}. Will re-queue.`);
            await this.sleep(RATE_LIMIT_WAIT_MS);
            return { session: null, rateLimited: false, sessionLimitHit: true };
          }
        }
        
        if (response.status === 403) {
          console.error(`Access forbidden. Check API key permissions.`);
          throw new Error('Devin API access forbidden');
        }
        
        console.error(`Failed to create session for batch ${batch.id}: ${response.status} - ${errorText}`);
        return { session: null, rateLimited: false, sessionLimitHit: false };
      }

      const data = await response.json() as DevinCreateSessionResponse;
      
      const session: DevinSession = {
        sessionId: data.session_id,
        url: data.url,
        status: 'working' as SessionStatus,
        batchId: batch.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
      };
      
      return { session, rateLimited: false, sessionLimitHit: false };
    } catch (error) {
      if (error instanceof Error && (error.message.includes('authentication') || error.message.includes('forbidden'))) {
        throw error; // Re-throw auth errors to stop the orchestrator
      }
      console.error(`Error creating session for batch ${batch.id}:`, error);
      return { session: null, rateLimited: false, sessionLimitHit: false };
    }
  }

  async startSession(batch: AlertBatch): Promise<DevinSession | null> {
    const result = await this.startSessionWithRetry(batch);
    return result.session;
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

  /**
   * Explicitly close/end a Devin session when a batch completes.
   * This frees up the session slot so new sessions can be started.
   * Uses the DELETE /sessions/{id} endpoint to terminate the session.
   */
  private async cleanupSession(sessionId: string, batchId: string): Promise<void> {
    console.log(`[Orchestrator] Cleaning up session ${sessionId} for batch ${batchId}`);
    const terminated = await this.terminateSession(sessionId);
    if (terminated) {
      console.log(`[Orchestrator] Successfully terminated session ${sessionId} to free up session slot`);
    } else {
      console.warn(`[Orchestrator] Failed to terminate session ${sessionId}, slot may not be freed immediately`);
    }
  }

  /**
   * Get the CI check status for a PR.
   * Uses GitHub's combined status API to check all CI checks on the PR's head commit.
   * 
   * @param prUrl - The URL of the pull request
   * @returns 'success' if all checks pass, 'failure' if any fail, 'pending' otherwise
   */
  private async getPRCheckStatus(prUrl: string): Promise<'success' | 'failure' | 'pending'> {
    try {
      const prNumber = this.extractPRNumber(prUrl);
      if (!prNumber) {
        console.warn(`[Orchestrator] Could not extract PR number from URL: ${prUrl}`);
        return 'pending';
      }

      const [owner, repo] = this.repository.split('/');
      
      // Get the PR to find the head SHA
      const { data: pr } = await this.octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });

      const headSha = pr.head.sha;

      // Get combined status for the commit
      const { data: combinedStatus } = await this.octokit.repos.getCombinedStatusForRef({
        owner,
        repo,
        ref: headSha,
      });

      // Also check for check runs (GitHub Actions uses check runs, not statuses)
      const { data: checkRuns } = await this.octokit.checks.listForRef({
        owner,
        repo,
        ref: headSha,
      });

      // If there are no checks at all, consider it pending (checks may not have started yet)
      if (combinedStatus.statuses.length === 0 && checkRuns.check_runs.length === 0) {
        console.log(`[Orchestrator] No CI checks found yet for PR #${prNumber}`);
        return 'pending';
      }

      // Check the combined status (for traditional CI systems)
      const statusState = combinedStatus.state;

      // Check the check runs (for GitHub Actions)
      const checkRunsComplete = checkRuns.check_runs.every(
        run => run.status === 'completed'
      );
      const checkRunsAllPassed = checkRuns.check_runs.every(
        run => run.conclusion === 'success' || run.conclusion === 'skipped'
      );
      const checkRunsAnyFailed = checkRuns.check_runs.some(
        run => run.conclusion === 'failure' || run.conclusion === 'cancelled' || run.conclusion === 'timed_out'
      );

      console.log(`[Orchestrator] PR #${prNumber} CI status: combinedStatus=${statusState}, checkRunsComplete=${checkRunsComplete}, checkRunsAllPassed=${checkRunsAllPassed}`);

      // Determine overall status
      if (statusState === 'failure' || checkRunsAnyFailed) {
        return 'failure';
      }

      if (statusState === 'success' && checkRunsComplete && checkRunsAllPassed) {
        return 'success';
      }

      if (statusState === 'pending' || !checkRunsComplete) {
        return 'pending';
      }

      // If combined status is success but check runs are still running
      if (!checkRunsComplete) {
        return 'pending';
      }

      // Default to success if combined status is success and all check runs passed
      return 'success';
    } catch (error) {
      console.error(`[Orchestrator] Error getting PR check status:`, error);
      return 'pending';
    }
  }

  /**
   * Wait for CI checks to pass on a PR, with retry attempts if CI fails.
   * Sends messages to Devin asking it to fix CI failures.
   * 
   * @param prUrl - The URL of the pull request
   * @param sessionId - The Devin session ID to message if CI fails
   * @returns true if CI passed, false if CI failed after max attempts or timeout
   */
  private async waitForCIChecks(prUrl: string, sessionId: string): Promise<boolean> {
    let ciAttempts = 0;
    const ciStartTime = Date.now();

    console.log(`[Orchestrator] Starting CI check monitoring for ${prUrl}`);

    while (ciAttempts < MAX_CI_ATTEMPTS && Date.now() - ciStartTime < CI_TIMEOUT_MS) {
      await this.sleep(CI_POLL_INTERVAL_MS);

      const ciStatus = await this.getPRCheckStatus(prUrl);

      if (ciStatus === 'success') {
        console.log(`[Orchestrator] CI passed for ${prUrl}`);
        return true;
      } else if (ciStatus === 'failure') {
        ciAttempts++;
        console.log(`[Orchestrator] CI failed for ${prUrl}, asking Devin to fix (attempt ${ciAttempts}/${MAX_CI_ATTEMPTS})`);

        if (ciAttempts < MAX_CI_ATTEMPTS) {
          await this.sendMessage(
            sessionId,
            'The CI checks failed on your PR. Please review the check failures and push fixes.'
          );
        }
      }
      // If 'pending', keep polling
    }

    if (Date.now() - ciStartTime >= CI_TIMEOUT_MS) {
      console.log(`[Orchestrator] CI check timeout reached for ${prUrl}`);
    }

    return false;
  }

  /**
   * Blocks until a session slot becomes available (activeSessions.size < maxParallelSessions).
   * This is more elegant than breaking out of the loop when rate limited or session limit hit.
   * Polls every WAIT_FOR_SLOT_POLL_MS (5 seconds) until a slot is available or timeout is reached.
   * 
   * @param timeoutMs - Maximum time to wait for a slot (default: 5 minutes)
   * @returns true if a slot became available, false if timeout was reached
   */
  async waitForSessionSlot(timeoutMs: number = 300000): Promise<boolean> {
    const startTime = Date.now();
    
    while (this.activeSessions.size >= this.maxParallelSessions) {
      if (Date.now() - startTime > timeoutMs) {
        console.warn(`[Orchestrator] Timeout waiting for session slot after ${timeoutMs}ms`);
        return false;
      }
      
      console.log(`[Orchestrator] Waiting for session slot: ${this.activeSessions.size}/${this.maxParallelSessions} sessions active`);
      await this.sleep(WAIT_FOR_SLOT_POLL_MS);
    }
    
    console.log(`[Orchestrator] Session slot available: ${this.activeSessions.size}/${this.maxParallelSessions} sessions active`);
    return true;
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
