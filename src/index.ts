import * as core from '@actions/core';
import * as github from '@actions/github';
import { AlertFetcher } from './alertFetcher';
import { BatchingEngine } from './batchingEngine';
import { DevinOrchestrator } from './devinOrchestrator';
import { ConfidenceScorer } from './confidenceScorer';
import { LearningStoreManager } from './learningStore';
import { DashboardPublisher } from './dashboardPublisher';
import {
  RemediationRun,
  RemediationConfig,
  BatchingStrategy,
  Severity,
  AlertBatch,
  DevinSession,
  ControlState,
} from './types';

async function run(): Promise<void> {
  try {
    const devinApiKey = core.getInput('devin_api_key', { required: true });
    const githubToken = core.getInput('github_token', { required: true });
    const batchingStrategy = core.getInput('batching_strategy') as BatchingStrategy || 'severity-then-cwe';
    const maxBatchSize = parseInt(core.getInput('max_batch_size') || '5', 10);
    const maxParallelSessions = parseInt(core.getInput('max_parallel_sessions') || '3', 10);
    const minConfidenceThreshold = parseFloat(core.getInput('min_confidence_threshold') || '0.7');
    const severityFilter = (core.getInput('severity_filter') || 'critical,high,medium')
      .split(',')
      .map(s => s.trim() as Severity);
    const minAlertsThreshold = parseInt(core.getInput('min_alerts_threshold') || '3', 10);
    const dashboardBranch = core.getInput('dashboard_branch') || 'gh-pages';
    const dryRun = core.getInput('dry_run') === 'true';

    const repository = core.getInput('repository') || 
      `${github.context.repo.owner}/${github.context.repo.repo}`;

    const config: RemediationConfig = {
      batchingStrategy,
      maxBatchSize,
      maxParallelSessions,
      minConfidenceThreshold,
      severityFilter,
      minAlertsThreshold,
      dryRun,
    };

    core.info(`Starting CodeQL Remediation Orchestrator for ${repository}`);
    core.info(`Configuration: ${JSON.stringify(config, null, 2)}`);

    const alertFetcher = new AlertFetcher(githubToken, repository);
    const batchingEngine = new BatchingEngine(batchingStrategy, maxBatchSize);
    const learningStoreManager = new LearningStoreManager(githubToken, repository);
    const dashboardPublisher = new DashboardPublisher(githubToken, repository, dashboardBranch);

    core.info('Fetching CodeQL alerts...');
    const alerts = await alertFetcher.fetchAlerts(severityFilter);
    core.info(`Found ${alerts.length} open alerts`);

    if (alerts.length === 0) {
      core.info('No alerts to process. Exiting.');
      core.setOutput('alerts_processed', 0);
      core.setOutput('session_count', 0);
      core.setOutput('pr_count', 0);
      return;
    }

    if (alerts.length < minAlertsThreshold) {
      core.info(`Alert count (${alerts.length}) below threshold (${minAlertsThreshold}). Waiting for more alerts.`);
      core.setOutput('alerts_processed', 0);
      core.setOutput('session_count', 0);
      core.setOutput('pr_count', 0);
      return;
    }

    core.info('Loading learning store...');
    const learningStore = await learningStoreManager.load();
    core.info(`Loaded ${learningStore.records.length} historical records`);

    core.info('Triaging alerts by severity...');
    const triagedAlerts = alertFetcher.triageBySeverity(alerts);

    core.info(`Creating batches using strategy: ${batchingStrategy}...`);
    const batches = batchingEngine.createBatches(triagedAlerts);
    core.info(`Created ${batches.length} batches`);

    const batchSummary = batchingEngine.getBatchSummary(batches);
    core.info(`Batch summary: ${JSON.stringify(batchSummary, null, 2)}`);

    const securityScoreBefore = await alertFetcher.calculateSecurityScore();

    const runId = generateRunId();
    const remediationRun: RemediationRun = {
      id: runId,
      repository,
      startedAt: new Date().toISOString(),
      status: 'running',
      config,
      alertsTotal: alerts.length,
      alertsProcessed: 0,
      batches,
      sessions: [],
      prsCreated: [],
      securityPosture: {
        before: securityScoreBefore,
      },
      controlState: {
        paused: false,
        rebatchRequested: false,
        priorityOverrides: {},
        skipBatches: [],
      },
    };

    core.info('Deploying dashboard...');
    await dashboardPublisher.ensureDashboardBranchExists();
    const dashboardUrl = await dashboardPublisher.deployDashboard();
    await dashboardPublisher.publishRunData(remediationRun, learningStore);
    core.info(`Dashboard deployed at: ${dashboardUrl}`);
    core.setOutput('dashboard_url', dashboardUrl);
    core.setOutput('run_id', runId);

    if (dryRun) {
      core.info('Dry run mode - skipping Devin sessions');
      core.info('Batches that would be processed:');
      for (const batch of batches) {
        core.info(`  - ${batch.groupKey}: ${batch.alerts.length} alerts (${batch.severity})`);
      }
      core.setOutput('alerts_processed', alerts.length);
      core.setOutput('session_count', 0);
      core.setOutput('pr_count', 0);
      return;
    }

    const devinOrchestrator = new DevinOrchestrator(devinApiKey, maxParallelSessions, repository, githubToken);
    const confidenceScorer = new ConfidenceScorer(githubToken, repository, learningStore);

    const checkPaused = async (): Promise<boolean> => {
      const controlState = await dashboardPublisher.readControlState();
      remediationRun.controlState = controlState;
      return controlState.paused;
    };

    const onProgress = async (batch: AlertBatch, session: DevinSession): Promise<void> => {
      core.info(`Batch ${batch.id} progress: ${session.structuredOutput?.progress || 0}%`);
      
      const sessionIndex = remediationRun.sessions.findIndex(s => s.sessionId === session.sessionId);
      if (sessionIndex >= 0) {
        remediationRun.sessions[sessionIndex] = session;
      } else {
        remediationRun.sessions.push(session);
      }

      await dashboardPublisher.publishRunData(remediationRun, learningStore);
    };

    const onComplete = async (batch: AlertBatch, session: DevinSession): Promise<void> => {
      core.info(`Batch ${batch.id} completed with status: ${batch.status}`);
      
      remediationRun.alertsProcessed += batch.alerts.length;

      if (session.structuredOutput?.prUrl) {
        remediationRun.prsCreated.push(session.structuredOutput.prUrl);
        
        const prNumber = extractPRNumber(session.structuredOutput.prUrl);
        if (prNumber) {
          const confidenceSignals = await confidenceScorer.calculateConfidence(
            batch,
            session.structuredOutput,
            prNumber
          );
          
          batch.confidenceScore = confidenceSignals.overall;
          
          core.info(`Confidence score for batch ${batch.id}: ${(confidenceSignals.overall * 100).toFixed(0)}%`);
          core.info(`Explanation: ${confidenceSignals.explanation}`);

          if (confidenceScorer.needsHumanReview(confidenceSignals, minConfidenceThreshold)) {
            core.warning(`Batch ${batch.id} needs human review (confidence: ${(confidenceSignals.overall * 100).toFixed(0)}%)`);
          }
        }

        learningStoreManager.recordFixAttempt(
          batch,
          session,
          'pending',
          'success'
        );
      } else if (batch.status === 'failed') {
        learningStoreManager.recordFixAttempt(
          batch,
          session,
          'failed',
          'failure',
          'Session failed to create PR'
        );
      }

      await dashboardPublisher.publishRunData(remediationRun, learningStore);
    };

    core.info('Starting Devin sessions...');
    await devinOrchestrator.processBatches(
      batches,
      onProgress,
      onComplete,
      checkPaused
    );

    const securityScoreAfter = await alertFetcher.calculateSecurityScore();
    remediationRun.securityPosture.after = securityScoreAfter;
    remediationRun.status = 'completed';
    remediationRun.completedAt = new Date().toISOString();

    await learningStoreManager.save();
    await dashboardPublisher.publishRunData(remediationRun, learningStore);

    const improvement = securityScoreBefore.total - securityScoreAfter.total;
    core.info(`Remediation complete!`);
    core.info(`Security improvement: ${improvement} vulnerabilities fixed`);
    core.info(`PRs created: ${remediationRun.prsCreated.length}`);

    core.setOutput('alerts_processed', remediationRun.alertsProcessed);
    core.setOutput('session_count', remediationRun.sessions.length);
    core.setOutput('pr_count', remediationRun.prsCreated.length);

  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('An unexpected error occurred');
    }
  }
}

function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `run-${timestamp}-${random}`;
}

function extractPRNumber(prUrl: string): number | null {
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

run();
