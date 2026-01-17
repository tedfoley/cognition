import { Octokit } from '@octokit/rest';
import {
  LearningStore,
  LearningRecord,
  FixOutcome,
  AlertBatch,
  DevinSession,
} from './types';

const LEARNING_FILE_PATH = '.codeql-remediation/learning-data.json';
const LEARNING_STORE_VERSION = '1.0.0';

export class LearningStoreManager {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private store: LearningStore;
  private branch: string;

  constructor(token: string, repository: string, branch: string = 'main') {
    this.octokit = new Octokit({ auth: token });
    const [owner, repo] = repository.split('/');
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.store = this.createEmptyStore();
  }

  async load(): Promise<LearningStore> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: LEARNING_FILE_PATH,
        ref: this.branch,
      });

      if ('content' in data) {
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        this.store = JSON.parse(content);
        
        if (!this.store.version) {
          this.store = this.migrateStore(this.store);
        }
      }
    } catch (error: any) {
      if (error.status === 404) {
        console.log('Learning store not found, creating new one');
        this.store = this.createEmptyStore();
      } else {
        console.error('Error loading learning store:', error);
        this.store = this.createEmptyStore();
      }
    }

    return this.store;
  }

  async save(): Promise<boolean> {
    this.store.lastUpdated = new Date().toISOString();
    
    const content = JSON.stringify(this.store, null, 2);
    const encodedContent = Buffer.from(content).toString('base64');

    try {
      let sha: string | undefined;
      
      try {
        const { data } = await this.octokit.repos.getContent({
          owner: this.owner,
          repo: this.repo,
          path: LEARNING_FILE_PATH,
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
        path: LEARNING_FILE_PATH,
        message: 'Update CodeQL remediation learning data',
        content: encodedContent,
        branch: this.branch,
        sha,
      });

      return true;
    } catch (error) {
      console.error('Error saving learning store:', error);
      return false;
    }
  }

  recordFixAttempt(
    batch: AlertBatch,
    session: DevinSession,
    outcome: FixOutcome,
    actualResult: 'success' | 'failure',
    failureReason?: string
  ): void {
    for (const alert of batch.alerts) {
      const cwe = alert.cwe?.[0] || 'UNKNOWN';
      const patternHash = this.generatePatternHash(alert.rule.id, cwe);

      const record: LearningRecord = {
        id: this.generateId(),
        cwe,
        ruleId: alert.rule.id,
        patternHash,
        outcome,
        confidenceScore: batch.confidenceScore || 0.5,
        actualResult,
        failureReason,
        timestamp: new Date().toISOString(),
        repository: `${this.owner}/${this.repo}`,
        prUrl: batch.prUrl,
      };

      this.store.records.push(record);
      this.updatePatterns(record);
    }
  }

  recordPROutcome(prUrl: string, outcome: 'merged' | 'rejected' | 'reverted'): void {
    const records = this.store.records.filter(r => r.prUrl === prUrl);
    
    for (const record of records) {
      record.outcome = outcome;
      record.actualResult = outcome === 'merged' ? 'success' : 'failure';
      
      if (outcome === 'rejected') {
        record.failureReason = 'PR was rejected during review';
      } else if (outcome === 'reverted') {
        record.failureReason = 'Fix was reverted after merge';
      }

      this.updatePatterns(record);
    }
  }

  performRCA(prUrl: string, failureReason: string): void {
    const records = this.store.records.filter(r => r.prUrl === prUrl);
    
    for (const record of records) {
      record.failureReason = failureReason;
      
      const pattern = this.store.patterns[record.cwe];
      if (pattern && !pattern.failureReasons.includes(failureReason)) {
        pattern.failureReasons.push(failureReason);
      }
    }
  }

  getSuccessRateForCWE(cwe: string): number {
    const pattern = this.store.patterns[cwe];
    return pattern?.successRate || 0.5;
  }

  getCommonFixesForCWE(cwe: string): string[] {
    const pattern = this.store.patterns[cwe];
    return pattern?.commonFixes || [];
  }

  getFailureReasonsForCWE(cwe: string): string[] {
    const pattern = this.store.patterns[cwe];
    return pattern?.failureReasons || [];
  }

  getOverallStats(): {
    totalRecords: number;
    overallSuccessRate: number;
    topCWEs: { cwe: string; count: number; successRate: number }[];
  } {
    const successfulRecords = this.store.records.filter(
      r => r.actualResult === 'success'
    ).length;

    const cweStats = Object.entries(this.store.patterns)
      .map(([cwe, pattern]) => ({
        cwe,
        count: pattern.totalAttempts,
        successRate: pattern.successRate,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalRecords: this.store.records.length,
      overallSuccessRate: this.store.records.length > 0 
        ? successfulRecords / this.store.records.length 
        : 0,
      topCWEs: cweStats,
    };
  }

  getRecentRecords(limit: number = 50): LearningRecord[] {
    return [...this.store.records]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  }

  getStore(): LearningStore {
    return this.store;
  }

  private updatePatterns(record: LearningRecord): void {
    if (!this.store.patterns[record.cwe]) {
      this.store.patterns[record.cwe] = {
        successRate: 0,
        totalAttempts: 0,
        commonFixes: [],
        failureReasons: [],
      };
    }

    const pattern = this.store.patterns[record.cwe];
    pattern.totalAttempts++;

    const cweRecords = this.store.records.filter(r => r.cwe === record.cwe);
    const successfulRecords = cweRecords.filter(r => r.actualResult === 'success').length;
    pattern.successRate = successfulRecords / cweRecords.length;

    if (record.failureReason && !pattern.failureReasons.includes(record.failureReason)) {
      pattern.failureReasons.push(record.failureReason);
      
      if (pattern.failureReasons.length > 10) {
        pattern.failureReasons = pattern.failureReasons.slice(-10);
      }
    }
  }

  private createEmptyStore(): LearningStore {
    return {
      version: LEARNING_STORE_VERSION,
      lastUpdated: new Date().toISOString(),
      records: [],
      patterns: {},
    };
  }

  private migrateStore(oldStore: any): LearningStore {
    return {
      version: LEARNING_STORE_VERSION,
      lastUpdated: new Date().toISOString(),
      records: oldStore.records || [],
      patterns: oldStore.patterns || {},
    };
  }

  private generatePatternHash(ruleId: string, cwe: string): string {
    const input = `${ruleId}-${cwe}`;
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  private generateId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
}
