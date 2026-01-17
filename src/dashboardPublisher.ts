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

  constructor(token: string, repository: string, branch: string = 'gh-pages') {
    this.octokit = new Octokit({ auth: token });
    const [owner, repo] = repository.split('/');
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
  }

  async publishRunData(run: RemediationRun, learningStore: LearningStore | null): Promise<string> {
    const dashboardData: DashboardData = {
      run,
      learningStats: this.calculateLearningStats(learningStore),
    };

    await this.writeFile(
      DASHBOARD_DATA_PATH,
      JSON.stringify(dashboardData, null, 2),
      `Update remediation run data: ${run.id}`
    );

    return this.getDashboardUrl();
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
            const [runResponse, controlResponse] = await Promise.all([
              fetch('data/remediation-data.json'),
              fetch('data/control-state.json').catch(() => ({ ok: false }))
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
        const interval = setInterval(fetchData, 10000);
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
          <SecurityPosture run={run} />
          <BatchProgress batches={run.batches} />
          <SessionList sessions={run.sessions} />
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
      const improvement = after ? before.total - after.total : 0;

      return (
        <div className="mb-8 bg-gray-800 rounded-lg p-6">
          <h2 className="text-xl font-bold mb-4">Security Posture</h2>
          <div className="grid grid-cols-2 gap-8">
            <div>
              <h3 className="text-gray-400 mb-2">Before</h3>
              <SeverityBars score={before} />
            </div>
            <div>
              <h3 className="text-gray-400 mb-2">After {after ? '' : '(Projected)'}</h3>
              <SeverityBars score={after || before} projected={!after} />
            </div>
          </div>
          {improvement > 0 && (
            <div className="mt-4 text-center">
              <span className="text-green-400 text-lg font-bold">
                {improvement} vulnerabilities fixed!
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
      const statusColors = {
        pending: 'bg-gray-600',
        in_progress: 'bg-blue-500 animate-pulse',
        completed: 'bg-green-500',
        failed: 'bg-red-500',
      };

      return (
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={\`w-3 h-3 rounded-full \${statusColors[batch.status]}\`}></div>
              <div>
                <span className="font-medium">{batch.groupKey}</span>
                <span className="text-gray-400 ml-2">({batch.alerts.length} alerts)</span>
              </div>
            </div>
            <div className="flex items-center gap-4">
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
                <a href={batch.sessionUrl} target="_blank" className="text-blue-400 hover:underline text-sm">
                  View Session
                </a>
              )}
              {batch.prUrl && (
                <a href={batch.prUrl} target="_blank" className="text-green-400 hover:underline text-sm">
                  View PR
                </a>
              )}
            </div>
          </div>
        </div>
      );
    }

    function SessionList({ sessions }) {
      if (!sessions || sessions.length === 0) return null;

      return (
        <div className="mb-8">
          <h2 className="text-xl font-bold mb-4">Active Sessions</h2>
          <div className="grid grid-cols-2 gap-4">
            {sessions.map((session) => (
              <div key={session.sessionId} className="bg-gray-800 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium">Session {session.sessionId.slice(0, 8)}...</span>
                  <span className={\`px-2 py-1 rounded text-xs \${
                    session.status === 'running' ? 'bg-blue-500' :
                    session.status === 'stopped' ? 'bg-green-500' : 'bg-gray-500'
                  }\`}>
                    {session.status}
                  </span>
                </div>
                {session.structuredOutput && (
                  <div className="text-sm text-gray-400">
                    <p>Progress: {session.structuredOutput.progress || 0}%</p>
                    <p>Current: {session.structuredOutput.currentTask || 'N/A'}</p>
                  </div>
                )}
                <a href={session.url} target="_blank" className="text-blue-400 hover:underline text-sm mt-2 block">
                  Open in Devin
                </a>
              </div>
            ))}
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
