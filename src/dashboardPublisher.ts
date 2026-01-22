import { Octokit } from '@octokit/rest';
import {
  RemediationRun,
  DashboardData,
  AlertBatch,
  DevinSession,
  ControlState,
  LearningStore,
} from './types';

const DASHBOARD_DATA_PATH = 'data/remediation-data.json';
const CONTROL_STATE_PATH = 'data/control-state.json';

export class DashboardPublisher {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private branch: string;

  /**
   * @param token - GitHub token for API access
   * @param dashboardRepository - Repository where the dashboard will be deployed (owner/repo format)
   * @param branch - Branch for GitHub Pages (default: gh-pages)
   */
  constructor(token: string, dashboardRepository: string, branch: string = 'gh-pages') {
    this.octokit = new Octokit({ auth: token });
    const [owner, repo] = dashboardRepository.split('/');
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
  }

  async publishRunData(run: RemediationRun, learningStore: LearningStore | null): Promise<string> {
    try {
      const dashboardData: DashboardData = {
        run,
        learningStats: this.calculateLearningStats(learningStore),
      };

      await this.writeFile(
        DASHBOARD_DATA_PATH,
        JSON.stringify(dashboardData, null, 2),
        `Update remediation run data: ${run.id}`
      );

      console.log(`Successfully published dashboard data for run ${run.id}`);
      return this.getDashboardUrl();
    } catch (error) {
      console.error(`Failed to publish dashboard data for run ${run.id}:`, error);
      throw error;
    }
  }

  async updateBatchStatus(runId: string, batch: AlertBatch): Promise<void> {
    const data = await this.readRunData();
    
    if (data && data.run.id === runId) {
      const batchIndex = data.run.batches.findIndex(b => b.id === batch.id);
      
      if (batchIndex >= 0) {
        data.run.batches[batchIndex] = batch;
        await this.writeFile(
          DASHBOARD_DATA_PATH,
          JSON.stringify(data, null, 2),
          `Update batch status: ${batch.id}`
        );
      }
    }
  }

  async updateSessionStatus(runId: string, session: DevinSession): Promise<void> {
    const data = await this.readRunData();
    
    if (data && data.run.id === runId) {
      const sessionIndex = data.run.sessions.findIndex(s => s.sessionId === session.sessionId);
      
      if (sessionIndex >= 0) {
        data.run.sessions[sessionIndex] = session;
      } else {
        data.run.sessions.push(session);
      }
      
      await this.writeFile(
        DASHBOARD_DATA_PATH,
        JSON.stringify(data, null, 2),
        `Update session status: ${session.sessionId}`
      );
    }
  }

  async readControlState(): Promise<ControlState> {
    try {
      const content = await this.readFile(CONTROL_STATE_PATH);
      
      if (content) {
        return JSON.parse(content);
      }
    } catch (error) {
      console.log('No control state found, using defaults');
    }

    return {
      paused: false,
      rebatchRequested: false,
      priorityOverrides: {},
      skipBatches: [],
    };
  }

  async writeControlState(state: ControlState): Promise<void> {
    await this.writeFile(
      CONTROL_STATE_PATH,
      JSON.stringify(state, null, 2),
      'Update control state'
    );
  }

  async requestPause(): Promise<void> {
    const state = await this.readControlState();
    state.paused = true;
    state.pausedAt = new Date().toISOString();
    await this.writeControlState(state);
  }

  async requestResume(): Promise<void> {
    const state = await this.readControlState();
    state.paused = false;
    state.pausedAt = undefined;
    await this.writeControlState(state);
  }

  async requestRebatch(): Promise<void> {
    const state = await this.readControlState();
    state.rebatchRequested = true;
    await this.writeControlState(state);
  }

  async setPriorityOverride(batchId: string, priority: number): Promise<void> {
    const state = await this.readControlState();
    state.priorityOverrides[batchId] = priority;
    await this.writeControlState(state);
  }

  async skipBatch(batchId: string): Promise<void> {
    const state = await this.readControlState();
    if (!state.skipBatches.includes(batchId)) {
      state.skipBatches.push(batchId);
    }
    await this.writeControlState(state);
  }

  async ensureDashboardBranchExists(): Promise<void> {
    try {
      await this.octokit.repos.getBranch({
        owner: this.owner,
        repo: this.repo,
        branch: this.branch,
      });
    } catch (error: any) {
      if (error.status === 404) {
        const { data: defaultBranch } = await this.octokit.repos.get({
          owner: this.owner,
          repo: this.repo,
        });

        const { data: ref } = await this.octokit.git.getRef({
          owner: this.owner,
          repo: this.repo,
          ref: `heads/${defaultBranch.default_branch}`,
        });

        await this.octokit.git.createRef({
          owner: this.owner,
          repo: this.repo,
          ref: `refs/heads/${this.branch}`,
          sha: ref.object.sha,
        });

        console.log(`Created branch ${this.branch}`);
      } else {
        throw error;
      }
    }
  }

  async deployDashboard(): Promise<string> {
    await this.ensureDashboardBranchExists();

    const indexHtml = this.generateDashboardHTML();
    
    await this.writeFile('index.html', indexHtml, 'Deploy dashboard');

    return this.getDashboardUrl();
  }

  getDashboardUrl(): string {
    return `https://${this.owner}.github.io/${this.repo}/`;
  }

  private async readRunData(): Promise<DashboardData | null> {
    try {
      const content = await this.readFile(DASHBOARD_DATA_PATH);
      return content ? JSON.parse(content) : null;
    } catch (error) {
      return null;
    }
  }

  private async readFile(path: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ref: this.branch,
      });

      if ('content' in data) {
        return Buffer.from(data.content, 'base64').toString('utf-8');
      }
    } catch (error: any) {
      if (error.status !== 404) {
        console.error(`Error reading file ${path}:`, error);
      }
    }

    return null;
  }

  private async writeFile(path: string, content: string, message: string): Promise<void> {
    const encodedContent = Buffer.from(content).toString('base64');

    let sha: string | undefined;
    
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ref: this.branch,
      });
      
      if ('sha' in data) {
        sha = data.sha;
      }
    } catch (error: any) {
      if (error.status !== 404) {
        throw error;
      }
    }

    await this.octokit.repos.createOrUpdateFileContents({
      owner: this.owner,
      repo: this.repo,
      path,
      message,
      content: encodedContent,
      branch: this.branch,
      sha,
    });
  }

  private calculateLearningStats(learningStore: LearningStore | null): DashboardData['learningStats'] {
    if (!learningStore || learningStore.records.length === 0) {
      return {
        totalRecords: 0,
        overallSuccessRate: 0,
        topCWEs: [],
      };
    }

    const successfulRecords = learningStore.records.filter(
      r => r.actualResult === 'success'
    ).length;

    const topCWEs = Object.entries(learningStore.patterns)
      .map(([cwe, pattern]) => ({
        cwe,
        count: pattern.totalAttempts,
        successRate: pattern.successRate,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalRecords: learningStore.records.length,
      overallSuccessRate: successfulRecords / learningStore.records.length,
      topCWEs,
    };
  }

  private generateDashboardHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodeQL Remediation Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <style>
    .animate-pulse-slow { animation: pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
    .status-pending { background-color: #6b7280; }
    .status-in_progress { background-color: #3b82f6; }
    .status-completed { background-color: #10b981; }
    .status-failed { background-color: #ef4444; }
  </style>
</head>
<body class="bg-gray-900 text-white min-h-screen">
  <div id="root"></div>
  <script type="text/babel">
    const { useState, useEffect } = React;

    function App() {
      const [data, setData] = useState(null);
      const [controlState, setControlState] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);

      useEffect(() => {
        const fetchData = async () => {
          try {
            // Add cache-busting timestamp and random component to prevent stale data from GitHub Pages caching
            const cacheBuster = \`?t=\${Date.now()}&r=\${Math.random().toString(36).substr(2, 9)}\`;
            const [runResponse, controlResponse] = await Promise.all([
              fetch(\`data/remediation-data.json\${cacheBuster}\`),
              fetch(\`data/control-state.json\${cacheBuster}\`).catch(() => ({ ok: false }))
            ]);

            if (runResponse.ok) {
              const runData = await runResponse.json();
              setData(runData);
            }

            if (controlResponse.ok) {
              const controlData = await controlResponse.json();
              setControlState(controlData);
            }

            setLoading(false);
          } catch (err) {
            setError(err.message);
            setLoading(false);
          }
        };

        fetchData();
        // Poll every 5 seconds for more responsive updates
        const interval = setInterval(fetchData, 5000);
        return () => clearInterval(interval);
      }, []);

      if (loading) {
        return (
          <div className="flex items-center justify-center min-h-screen">
            <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-500"></div>
          </div>
        );
      }

      if (error || !data) {
        return (
          <div className="flex items-center justify-center min-h-screen">
            <div className="text-center">
              <h1 className="text-2xl font-bold mb-4">No Active Remediation Run</h1>
              <p className="text-gray-400">Waiting for a remediation run to start...</p>
            </div>
          </div>
        );
      }

      const { run, learningStats } = data;

      return (
        <div className="container mx-auto px-4 py-8">
          <Header run={run} controlState={controlState} />
          <ControlPanel run={run} controlState={controlState} />
          <ProgressOverview run={run} />
          <SecurityPosture run={run} />
          <BatchProgress batches={run.batches} />
          <SessionList sessions={run.sessions} batches={run.batches} />
          <LearningStats stats={learningStats} />
        </div>
      );
    }

    function Header({ run, controlState }) {
      const statusColors = {
        running: 'bg-blue-500',
        completed: 'bg-green-500',
        failed: 'bg-red-500',
        paused: 'bg-yellow-500',
      };

      return (
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold">CodeQL Remediation Dashboard</h1>
              <p className="text-gray-400 mt-1">{run.repository}</p>
            </div>
            <div className="flex items-center gap-4">
              <span className={\`px-3 py-1 rounded-full text-sm font-medium \${statusColors[run.status] || 'bg-gray-500'}\`}>
                {run.status.toUpperCase()}
              </span>
              {controlState?.paused && (
                <span className="px-3 py-1 rounded-full text-sm font-medium bg-yellow-500">
                  PAUSED
                </span>
              )}
            </div>
          </div>
          <div className="mt-4 grid grid-cols-4 gap-4">
            <StatCard label="Total Alerts" value={run.alertsTotal} />
            <StatCard label="Processed" value={run.alertsProcessed} />
            <StatCard label="Batches" value={run.batches.length} />
            <StatCard label="PRs Created" value={run.prsCreated.length} />
          </div>
        </div>
      );
    }

    function ControlPanel({ run, controlState }) {
      if (run.status === 'completed' || run.status === 'failed') {
        return null;
      }

      const workflowUrl = \`https://github.com/\${run.repository}/actions\`;

      return (
        <div className="mb-6 bg-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Controls</h2>
            <div className="flex gap-3 items-center">
              <span className={\`px-3 py-1 rounded-full text-sm \${controlState?.paused ? 'bg-yellow-600' : 'bg-gray-600'}\`}>
                {controlState?.paused ? 'Paused' : 'Running'}
              </span>
              <a 
                href={workflowUrl} 
                target="_blank" 
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors text-sm"
              >
                Manage via Actions
              </a>
            </div>
          </div>
        </div>
      );
    }

    function ProgressOverview({ run }) {
      // Calculate estimated time to completion
      const completedBatches = run.batches.filter(b => b.status === 'completed' || b.status === 'failed').length;
      const inProgressBatches = run.batches.filter(b => b.status === 'in_progress').length;
      const pendingBatches = run.batches.filter(b => b.status === 'pending').length;
      const totalBatches = run.batches.length;
      
      // Estimate based on average time per batch (assume ~15 min per batch if no data)
      const AVG_MINUTES_PER_BATCH = 15;
      
      // Calculate actual average if we have completed batches with timing data
      let actualAvgMinutes = AVG_MINUTES_PER_BATCH;
      let timeSource = 'estimated';
      const completedWithTiming = run.batches.filter(b => b.startedAt && b.completedAt);
      if (completedWithTiming.length >= 2) {
        timeSource = \`based on \${completedWithTiming.length} completed\`;
        const totalMinutes = completedWithTiming.reduce((sum, b) => {
          const start = new Date(b.startedAt).getTime();
          const end = new Date(b.completedAt).getTime();
          return sum + (end - start) / 60000;
        }, 0);
        actualAvgMinutes = totalMinutes / completedWithTiming.length;
      }
      
      const refinedEstimate = (pendingBatches + inProgressBatches * 0.5) * actualAvgMinutes;
      const progressPercent = totalBatches > 0 ? (completedBatches / totalBatches) * 100 : 0;

      const formatTime = (minutes) => {
        if (minutes < 1) return 'Less than a minute';
        if (minutes < 60) return \`~\${Math.round(minutes)} min\`;
        const hours = Math.floor(minutes / 60);
        const mins = Math.round(minutes % 60);
        return \`~\${hours}h \${mins}m\`;
      };

      return (
        <div className="mb-6 bg-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">Progress Overview</h2>
            <span className="text-2xl font-bold text-blue-400">{progressPercent.toFixed(0)}%</span>
          </div>
          
          <div className="w-full bg-gray-700 rounded-full h-4 mb-4">
            <div 
              className="bg-blue-500 h-4 rounded-full transition-all duration-500"
              style={{ width: \`\${progressPercent}%\` }}
            ></div>
          </div>
          
          <div className="grid grid-cols-4 gap-4 text-center text-sm">
            <div>
              <p className="text-gray-400">Completed</p>
              <p className="text-xl font-bold text-green-400">{completedBatches}</p>
            </div>
            <div>
              <p className="text-gray-400">In Progress</p>
              <p className="text-xl font-bold text-blue-400">{inProgressBatches}</p>
            </div>
            <div>
              <p className="text-gray-400">Pending</p>
              <p className="text-xl font-bold text-gray-400">{pendingBatches}</p>
            </div>
            <div>
              <p className="text-gray-400">Est. Time Left</p>
              <p className="text-xl font-bold text-yellow-400">{formatTime(refinedEstimate)}</p>
              <p className="text-xs text-gray-500">{timeSource}</p>
            </div>
          </div>
        </div>
      );
    }

    function StatCard({ label, value }) {
      return (
        <div className="bg-gray-800 rounded-lg p-4">
          <p className="text-gray-400 text-sm">{label}</p>
          <p className="text-2xl font-bold">{value}</p>
        </div>
      );
    }

    function SecurityPosture({ run }) {
      const { before, after } = run.securityPosture;
      
      // Calculate projected "After" based on in-progress and completed batches
      const calculateProjected = () => {
        const projected = { ...before };
        
        // Count alerts being fixed by in-progress and completed batches
        const activeBatches = run.batches.filter(b => 
          b.status === 'in_progress' || b.status === 'completed'
        );
        
        activeBatches.forEach(batch => {
          if (batch.alerts) {
            batch.alerts.forEach(alert => {
              const severity = alert.rule?.security_severity_level || 'low';
              if (projected[severity] > 0) {
                projected[severity]--;
              }
            });
          }
        });
        
        projected.total = projected.critical + projected.high + projected.medium + projected.low;
        return projected;
      };
      
      const projectedAfter = after || calculateProjected();
      const isProjected = !after;
      const improvement = before.total - projectedAfter.total;

      return (
        <div className="mb-8 bg-gray-800 rounded-lg p-6">
          <h2 className="text-xl font-bold mb-4">Security Posture</h2>
          <div className="grid grid-cols-2 gap-8">
            <div>
              <h3 className="text-gray-400 mb-2">Before</h3>
              <SeverityBars score={before} />
            </div>
            <div>
              <h3 className="text-gray-400 mb-2">
                After {isProjected && <span className="text-yellow-400 text-sm">(Projected)</span>}
              </h3>
              <SeverityBars score={projectedAfter} projected={isProjected} />
            </div>
          </div>
          {improvement > 0 && (
            <div className="mt-4 text-center">
              <span className={\`\${isProjected ? 'text-yellow-400' : 'text-green-400'} text-lg font-bold\`}>
                {improvement} vulnerabilities {isProjected ? 'being fixed' : 'fixed'}!
              </span>
            </div>
          )}
        </div>
      );
    }

    function SeverityBars({ score, projected }) {
      const severities = [
        { key: 'critical', label: 'Critical', color: 'bg-red-600' },
        { key: 'high', label: 'High', color: 'bg-orange-500' },
        { key: 'medium', label: 'Medium', color: 'bg-yellow-500' },
        { key: 'low', label: 'Low', color: 'bg-blue-400' },
      ];

      return (
        <div className="space-y-2">
          {severities.map(({ key, label, color }) => (
            <div key={key} className="flex items-center gap-2">
              <span className="w-16 text-sm text-gray-400">{label}</span>
              <div className="flex-1 bg-gray-700 rounded-full h-4">
                <div
                  className={\`\${color} h-4 rounded-full \${projected ? 'opacity-50' : ''}\`}
                  style={{ width: \`\${Math.min(score[key] * 10, 100)}%\` }}
                ></div>
              </div>
              <span className="w-8 text-right">{score[key]}</span>
            </div>
          ))}
        </div>
      );
    }

    function BatchProgress({ batches }) {
      return (
        <div className="mb-8">
          <h2 className="text-xl font-bold mb-4">Batch Progress</h2>
          <div className="space-y-3">
            {batches.map((batch) => (
              <BatchCard key={batch.id} batch={batch} />
            ))}
          </div>
        </div>
      );
    }

    function BatchCard({ batch }) {
      const [expanded, setExpanded] = useState(false);
      const statusColors = {
        pending: 'bg-gray-600',
        in_progress: 'bg-blue-500 animate-pulse',
        completed: 'bg-green-500',
        failed: 'bg-red-500',
      };

      // Get progress from session structured output if available
      const progress = batch.sessionProgress || 0;

      // Format timestamp
      const formatTime = (isoString) => {
        if (!isoString) return null;
        const date = new Date(isoString);
        return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      };

      return (
        <div className="bg-gray-800 rounded-lg p-4">
          <div 
            className="flex items-center justify-between cursor-pointer"
            onClick={() => setExpanded(!expanded)}
          >
            <div className="flex items-center gap-3">
              <div className={\`w-3 h-3 rounded-full \${statusColors[batch.status]}\`}></div>
              <div>
                <span className="font-medium">{batch.groupKey}</span>
                <span className="text-gray-400 ml-2">({batch.alerts.length} alerts)</span>
              </div>
              {/* Progress bar for in-progress batches */}
              {batch.status === 'in_progress' && (
                <div className="flex items-center gap-2 ml-4">
                  <div className="w-24 bg-gray-700 rounded-full h-2">
                    <div 
                      className="bg-blue-400 h-2 rounded-full transition-all duration-300"
                      style={{ width: \`\${progress}%\` }}
                    ></div>
                  </div>
                  <span className="text-sm text-blue-400">{progress}%</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-4">
              {/* Timestamps */}
              {batch.startedAt && (
                <span className="text-xs text-gray-500">
                  Started: {formatTime(batch.startedAt)}
                </span>
              )}
              {batch.completedAt && (
                <span className="text-xs text-gray-500">
                  Completed: {formatTime(batch.completedAt)}
                </span>
              )}
              <span className={\`px-2 py-1 rounded text-xs \${
                batch.severity === 'critical' ? 'bg-red-600' :
                batch.severity === 'high' ? 'bg-orange-500' :
                batch.severity === 'medium' ? 'bg-yellow-500' : 'bg-blue-400'
              }\`}>
                {batch.severity}
              </span>
              {batch.confidenceScore && (
                <span className="text-sm">
                  Confidence: {(batch.confidenceScore * 100).toFixed(0)}%
                </span>
              )}
              {batch.sessionUrl && (
                <a href={batch.sessionUrl} target="_blank" className="text-blue-400 hover:underline text-sm" onClick={(e) => e.stopPropagation()}>
                  View Session
                </a>
              )}
              {batch.prUrl && (
                <a href={batch.prUrl} target="_blank" className="text-green-400 hover:underline text-sm" onClick={(e) => e.stopPropagation()}>
                  View PR
                </a>
              )}
              {/* Expand/collapse indicator */}
              <span className="text-gray-400 text-sm">{expanded ? '▼' : '▶'}</span>
            </div>
          </div>
          
          {/* Expanded alerts section */}
          {expanded && batch.alerts && batch.alerts.length > 0 && (
            <div className="mt-4 pl-6 border-l-2 border-gray-700">
              <h4 className="text-sm font-medium text-gray-400 mb-2">Alerts in this batch:</h4>
              <div className="space-y-2">
                {batch.alerts.map((alert, idx) => (
                  <div key={alert.number || idx} className="bg-gray-700 rounded p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">#{alert.number}: {alert.rule?.name || 'Unknown Rule'}</span>
                      <span className={\`px-2 py-0.5 rounded text-xs \${
                        alert.rule?.severity === 'critical' ? 'bg-red-600' :
                        alert.rule?.severity === 'high' ? 'bg-orange-500' :
                        alert.rule?.severity === 'medium' ? 'bg-yellow-500' : 'bg-blue-400'
                      }\`}>
                        {alert.rule?.severity || 'unknown'}
                      </span>
                    </div>
                    <p className="text-gray-400 mt-1">
                      {alert.most_recent_instance?.location?.path || 'Unknown file'}
                      <span className="ml-2">Line {alert.most_recent_instance?.location?.start_line || '?'}</span>
                    </p>
                    {alert.cwe && alert.cwe.length > 0 && (
                      <p className="text-blue-400 mt-1 text-xs">
                        {alert.cwe.join(', ')}
                      </p>
                    )}
                    <p className="text-gray-500 mt-1 text-xs">
                      {alert.most_recent_instance?.message?.text || alert.rule?.description || 'No description'}
                    </p>
                    {alert.html_url && (
                      <a href={alert.html_url} target="_blank" className="text-blue-400 hover:underline text-xs mt-1 block" onClick={(e) => e.stopPropagation()}>
                        View on GitHub
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    function SessionList({ sessions, batches }) {
      if (!sessions || sessions.length === 0) return null;

      // Create a map of sessionId to batch for quick lookup
      const sessionToBatch = {};
      if (batches) {
        batches.forEach(batch => {
          if (batch.sessionId) {
            sessionToBatch[batch.sessionId] = batch;
          }
        });
      }

      return (
        <div className="mb-8">
          <h2 className="text-xl font-bold mb-4">Active Sessions</h2>
          <div className="grid grid-cols-2 gap-4">
            {sessions.map((session) => {
              const batch = sessionToBatch[session.sessionId];
              const displayName = batch ? batch.groupKey : \`Session \${session.sessionId.slice(0, 8)}...\`;
              
              return (
                <div key={session.sessionId} className="bg-gray-800 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium">{displayName}</span>
                    <span className={\`px-2 py-1 rounded text-xs \${
                      session.status === 'working' ? 'bg-blue-500' :
                      session.status === 'finished' ? 'bg-green-500' :
                      session.status === 'blocked' ? 'bg-yellow-500' :
                      session.status === 'expired' ? 'bg-red-500' : 'bg-gray-500'
                    }\`}>
                      {session.status}
                    </span>
                  </div>
                  {session.structuredOutput && (
                    <div className="text-sm text-gray-400">
                      <div className="flex items-center gap-2 mb-1">
                        <span>Progress:</span>
                        <div className="flex-1 bg-gray-700 rounded-full h-2">
                          <div 
                            className="bg-blue-400 h-2 rounded-full transition-all duration-300"
                            style={{ width: \`\${session.structuredOutput.progress || 0}%\` }}
                          ></div>
                        </div>
                        <span>{session.structuredOutput.progress || 0}%</span>
                      </div>
                      <p>Current: {session.structuredOutput.currentTask || 'N/A'}</p>
                    </div>
                  )}
                  <a href={session.url} target="_blank" className="text-blue-400 hover:underline text-sm mt-2 block">
                    Open in Devin
                  </a>
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    function LearningStats({ stats }) {
      if (!stats || stats.totalRecords === 0) return null;

      return (
        <div className="mb-8 bg-gray-800 rounded-lg p-6">
          <h2 className="text-xl font-bold mb-4">Learning Insights</h2>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <StatCard label="Total Fix Attempts" value={stats.totalRecords} />
            <StatCard label="Success Rate" value={\`\${(stats.overallSuccessRate * 100).toFixed(0)}%\`} />
            <StatCard label="CWE Types" value={stats.topCWEs.length} />
          </div>
          {stats.topCWEs.length > 0 && (
            <div>
              <h3 className="text-gray-400 mb-2">Top Vulnerability Types</h3>
              <div className="space-y-2">
                {stats.topCWEs.slice(0, 5).map(({ cwe, count, successRate }) => (
                  <div key={cwe} className="flex items-center justify-between">
                    <span>{cwe}</span>
                    <div className="flex items-center gap-4">
                      <span className="text-gray-400">{count} attempts</span>
                      <span className={\`\${successRate >= 0.7 ? 'text-green-400' : 'text-yellow-400'}\`}>
                        {(successRate * 100).toFixed(0)}% success
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    ReactDOM.render(<App />, document.getElementById('root'));
  </script>
</body>
</html>`;
  }
}
