export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'warning' | 'note' | 'error';

export type BatchingStrategy = 
  | 'severity-then-cwe'
  | 'severity-only'
  | 'by-file'
  | 'by-cwe'
  | 'by-complexity';

// Devin API status_enum values
export type SessionStatus = 
  | 'pending'
  | 'working'      // Devin is actively working
  | 'blocked'      // Devin is waiting for user input
  | 'finished'     // Devin completed the task
  | 'expired'      // Session timed out
  | 'suspended'    // Session was suspended
  | 'resumed';     // Session was resumed

export type FixOutcome = 
  | 'pending'
  | 'merged'
  | 'rejected'
  | 'reverted'
  | 'failed';

export interface CodeQLAlert {
  number: number;
  rule: {
    id: string;
    name: string;
    severity: Severity;
    description: string;
    tags: string[];
  };
  tool: {
    name: string;
    version: string;
  };
  most_recent_instance: {
    ref: string;
    state: string;
    commit_sha: string;
    message: {
      text: string;
    };
    location: {
      path: string;
      start_line: number;
      end_line: number;
      start_column: number;
      end_column: number;
    };
  };
  state: 'open' | 'fixed' | 'dismissed';
  created_at: string;
  updated_at: string;
  html_url: string;
  instances_url: string;
  cwe?: string[];
}

export interface AlertBatch {
  id: string;
  alerts: CodeQLAlert[];
  strategy: BatchingStrategy;
  groupKey: string;
  severity: Severity;
  priority: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  sessionId?: string;
  sessionUrl?: string;
  prUrl?: string;
  confidenceScore?: number;
  startedAt?: string;
  completedAt?: string;
}

export interface DevinSession {
  sessionId: string;
  url: string;
  status: SessionStatus;
  batchId: string;
  structuredOutput?: DevinStructuredOutput;
  prUrl?: string;  // PR URL from Devin API pull_request.url field
  createdAt: string;
  updatedAt: string;
  messages: DevinMessage[];
}

export interface DevinMessage {
  role: 'user' | 'devin';
  content: string;
  timestamp: string;
}

export interface DevinStructuredOutput {
  fixes: FixAttempt[];
  currentTask: string;
  progress: number;
  prUrl?: string;
  testResults?: TestResult[];
  confidenceScore?: number;
  confidenceExplanation?: string;
}

export interface FixAttempt {
  alertNumber: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  filePath: string;
  originalCode?: string;
  fixedCode?: string;
  explanation?: string;
  confidenceScore?: number;
  testsPassed?: boolean;
}

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface ConfidenceSignals {
  codeqlValidation: number;
  testCoverage: number;
  changeScope: number;
  historicalPattern: number;
  overall: number;
  explanation: string;
}

export interface LearningRecord {
  id: string;
  cwe: string;
  ruleId: string;
  patternHash: string;
  outcome: FixOutcome;
  confidenceScore: number;
  actualResult: 'success' | 'failure';
  failureReason?: string;
  timestamp: string;
  repository: string;
  prUrl?: string;
}

export interface LearningStore {
  version: string;
  lastUpdated: string;
  records: LearningRecord[];
  patterns: {
    [cwe: string]: {
      successRate: number;
      totalAttempts: number;
      commonFixes: string[];
      failureReasons: string[];
    };
  };
}

export interface RemediationRun {
  id: string;
  repository: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'paused';
  config: RemediationConfig;
  alertsTotal: number;
  alertsProcessed: number;
  batches: AlertBatch[];
  sessions: DevinSession[];
  prsCreated: string[];
  securityPosture: {
    before: SecurityScore;
    after?: SecurityScore;
  };
  controlState: ControlState;
}

export interface RemediationConfig {
  batchingStrategy: BatchingStrategy;
  maxBatchSize: number;
  maxParallelSessions: number;
  minConfidenceThreshold: number;
  severityFilter: Severity[];
  minAlertsThreshold: number;
  dryRun: boolean;
}

export interface SecurityScore {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  timestamp: string;
}

export interface ControlState {
  paused: boolean;
  pausedAt?: string;
  rebatchRequested: boolean;
  priorityOverrides: { [batchId: string]: number };
  skipBatches: string[];
}

export interface DashboardData {
  run: RemediationRun;
  learningStats: {
    totalRecords: number;
    overallSuccessRate: number;
    topCWEs: { cwe: string; count: number; successRate: number }[];
  };
}

export interface PRDescription {
  title: string;
  body: string;
  labels: string[];
}
