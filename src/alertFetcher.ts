import { Octokit } from '@octokit/rest';
import { CodeQLAlert, Severity, SecurityScore } from './types';

export class AlertFetcher {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(token: string, repository: string) {
    this.octokit = new Octokit({ auth: token });
    const [owner, repo] = repository.split('/');
    this.owner = owner;
    this.repo = repo;
  }

  async fetchAlerts(severityFilter: Severity[]): Promise<CodeQLAlert[]> {
    const alerts: CodeQLAlert[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const response = await this.octokit.codeScanning.listAlertsForRepo({
        owner: this.owner,
        repo: this.repo,
        state: 'open',
        per_page: perPage,
        page,
      });

      if (response.data.length === 0) {
        break;
      }

      for (const alert of response.data) {
        const severity = this.mapSeverity(alert.rule?.security_severity_level || alert.rule?.severity);
        
        if (severityFilter.includes(severity)) {
          alerts.push(this.transformAlert(alert, severity));
        }
      }

      if (response.data.length < perPage) {
        break;
      }

      page++;
    }

    return alerts;
  }

  async getAlertDetails(alertNumber: number): Promise<CodeQLAlert | null> {
    try {
      const response = await this.octokit.codeScanning.getAlert({
        owner: this.owner,
        repo: this.repo,
        alert_number: alertNumber,
      });

      const severity = this.mapSeverity(
        response.data.rule?.security_severity_level || response.data.rule?.severity
      );

      return this.transformAlert(response.data, severity);
    } catch (error) {
      console.error(`Failed to fetch alert ${alertNumber}:`, error);
      return null;
    }
  }

  async calculateSecurityScore(): Promise<SecurityScore> {
    const allAlerts = await this.fetchAllOpenAlerts();
    
    const score: SecurityScore = {
      total: allAlerts.length,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      timestamp: new Date().toISOString(),
    };

    for (const alert of allAlerts) {
      const severity = this.mapSeverity(
        alert.rule?.security_severity_level || alert.rule?.severity
      );
      
      switch (severity) {
        case 'critical':
          score.critical++;
          break;
        case 'high':
          score.high++;
          break;
        case 'medium':
          score.medium++;
          break;
        case 'low':
        case 'warning':
        case 'note':
          score.low++;
          break;
      }
    }

    return score;
  }

  private async fetchAllOpenAlerts(): Promise<any[]> {
    const alerts: any[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const response = await this.octokit.codeScanning.listAlertsForRepo({
        owner: this.owner,
        repo: this.repo,
        state: 'open',
        per_page: perPage,
        page,
      });

      if (response.data.length === 0) {
        break;
      }

      alerts.push(...response.data);

      if (response.data.length < perPage) {
        break;
      }

      page++;
    }

    return alerts;
  }

  private mapSeverity(severity: string | null | undefined): Severity {
    if (!severity) return 'medium';
    
    const severityLower = severity.toLowerCase();
    
    switch (severityLower) {
      case 'critical':
        return 'critical';
      case 'high':
        return 'high';
      case 'medium':
        return 'medium';
      case 'low':
        return 'low';
      case 'warning':
        return 'warning';
      case 'note':
        return 'note';
      case 'error':
        return 'error';
      default:
        return 'medium';
    }
  }

  private transformAlert(alert: any, severity: Severity): CodeQLAlert {
    const cweMatches = alert.rule?.tags?.filter((tag: string) => 
      tag.startsWith('external/cwe/cwe-')
    ) || [];
    
    const cwes = cweMatches.map((tag: string) => 
      tag.replace('external/cwe/', '').toUpperCase()
    );

    return {
      number: alert.number,
      rule: {
        id: alert.rule?.id || 'unknown',
        name: alert.rule?.name || 'Unknown Rule',
        severity,
        description: alert.rule?.description || '',
        tags: alert.rule?.tags || [],
      },
      tool: {
        name: alert.tool?.name || 'CodeQL',
        version: alert.tool?.version || 'unknown',
      },
      most_recent_instance: {
        ref: alert.most_recent_instance?.ref || '',
        state: alert.most_recent_instance?.state || 'open',
        commit_sha: alert.most_recent_instance?.commit_sha || '',
        message: {
          text: alert.most_recent_instance?.message?.text || '',
        },
        location: {
          path: alert.most_recent_instance?.location?.path || '',
          start_line: alert.most_recent_instance?.location?.start_line || 0,
          end_line: alert.most_recent_instance?.location?.end_line || 0,
          start_column: alert.most_recent_instance?.location?.start_column || 0,
          end_column: alert.most_recent_instance?.location?.end_column || 0,
        },
      },
      state: alert.state || 'open',
      created_at: alert.created_at || new Date().toISOString(),
      updated_at: alert.updated_at || new Date().toISOString(),
      html_url: alert.html_url || '',
      instances_url: alert.instances_url || '',
      cwe: cwes.length > 0 ? cwes : undefined,
    };
  }

  triageBySeverity(alerts: CodeQLAlert[]): CodeQLAlert[] {
    const severityOrder: Record<Severity, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
      warning: 4,
      note: 5,
      error: 1,
    };

    return [...alerts].sort((a, b) => {
      const severityDiff = severityOrder[a.rule.severity] - severityOrder[b.rule.severity];
      if (severityDiff !== 0) return severityDiff;
      
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
  }
}
