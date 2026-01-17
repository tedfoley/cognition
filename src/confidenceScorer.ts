import { Octokit } from '@octokit/rest';
import {
  AlertBatch,
  ConfidenceSignals,
  DevinStructuredOutput,
  FixAttempt,
  LearningStore,
} from './types';

export class ConfidenceScorer {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private learningStore: LearningStore | null;

  constructor(token: string, repository: string, learningStore: LearningStore | null = null) {
    this.octokit = new Octokit({ auth: token });
    const [owner, repo] = repository.split('/');
    this.owner = owner;
    this.repo = repo;
    this.learningStore = learningStore;
  }

  async calculateConfidence(
    batch: AlertBatch,
    structuredOutput: DevinStructuredOutput | undefined,
    prNumber?: number
  ): Promise<ConfidenceSignals> {
    const signals: ConfidenceSignals = {
      codeqlValidation: 0,
      testCoverage: 0,
      changeScope: 0,
      historicalPattern: 0,
      overall: 0,
      explanation: '',
    };

    const explanations: string[] = [];

    signals.codeqlValidation = await this.assessCodeQLValidation(batch, prNumber);
    explanations.push(this.explainCodeQLValidation(signals.codeqlValidation));

    signals.testCoverage = await this.assessTestCoverage(batch, prNumber);
    explanations.push(this.explainTestCoverage(signals.testCoverage));

    signals.changeScope = this.assessChangeScope(batch, structuredOutput);
    explanations.push(this.explainChangeScope(signals.changeScope));

    signals.historicalPattern = this.assessHistoricalPattern(batch);
    explanations.push(this.explainHistoricalPattern(signals.historicalPattern));

    const weights = {
      codeqlValidation: 0.40,
      testCoverage: 0.20,
      changeScope: 0.20,
      historicalPattern: 0.20,
    };

    signals.overall = 
      signals.codeqlValidation * weights.codeqlValidation +
      signals.testCoverage * weights.testCoverage +
      signals.changeScope * weights.changeScope +
      signals.historicalPattern * weights.historicalPattern;

    signals.explanation = explanations.filter(e => e).join(' ');

    return signals;
  }

  private async assessCodeQLValidation(batch: AlertBatch, prNumber?: number): Promise<number> {
    if (!prNumber) {
      return 0.5;
    }

    try {
      const { data: pr } = await this.octokit.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      });

      const { data: checks } = await this.octokit.checks.listForRef({
        owner: this.owner,
        repo: this.repo,
        ref: pr.head.sha,
      });

      const codeqlCheck = checks.check_runs.find(
        check => check.name.toLowerCase().includes('codeql') || 
                 check.name.toLowerCase().includes('code scanning')
      );

      if (!codeqlCheck) {
        return 0.5;
      }

      if (codeqlCheck.conclusion === 'success') {
        return 1.0;
      } else if (codeqlCheck.conclusion === 'failure') {
        return 0.2;
      } else if (codeqlCheck.status === 'in_progress') {
        return 0.6;
      }

      return 0.5;
    } catch (error) {
      console.error('Error assessing CodeQL validation:', error);
      return 0.5;
    }
  }

  private async assessTestCoverage(batch: AlertBatch, prNumber?: number): Promise<number> {
    if (!prNumber) {
      return 0.5;
    }

    try {
      const { data: pr } = await this.octokit.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      });

      const { data: checks } = await this.octokit.checks.listForRef({
        owner: this.owner,
        repo: this.repo,
        ref: pr.head.sha,
      });

      const testChecks = checks.check_runs.filter(
        check => check.name.toLowerCase().includes('test') ||
                 check.name.toLowerCase().includes('ci') ||
                 check.name.toLowerCase().includes('build')
      );

      if (testChecks.length === 0) {
        return 0.4;
      }

      const passedChecks = testChecks.filter(c => c.conclusion === 'success').length;
      const totalChecks = testChecks.length;

      return passedChecks / totalChecks;
    } catch (error) {
      console.error('Error assessing test coverage:', error);
      return 0.5;
    }
  }

  private assessChangeScope(
    batch: AlertBatch,
    structuredOutput: DevinStructuredOutput | undefined
  ): number {
    if (!structuredOutput?.fixes) {
      return this.assessChangeScopeFromBatch(batch);
    }

    const fixes = structuredOutput.fixes.filter(f => f.status === 'completed');
    
    if (fixes.length === 0) {
      return 0.5;
    }

    let totalScore = 0;

    for (const fix of fixes) {
      let fixScore = 1.0;

      if (fix.originalCode && fix.fixedCode) {
        const originalLines = fix.originalCode.split('\n').length;
        const fixedLines = fix.fixedCode.split('\n').length;
        const lineDiff = Math.abs(fixedLines - originalLines);

        if (lineDiff <= 3) {
          fixScore = 1.0;
        } else if (lineDiff <= 10) {
          fixScore = 0.8;
        } else if (lineDiff <= 25) {
          fixScore = 0.6;
        } else {
          fixScore = 0.4;
        }
      }

      totalScore += fixScore;
    }

    return totalScore / fixes.length;
  }

  private assessChangeScopeFromBatch(batch: AlertBatch): number {
    const uniqueFiles = new Set(
      batch.alerts.map(a => a.most_recent_instance.location.path)
    );

    const avgLineSpan = batch.alerts.reduce((sum, alert) => {
      const span = alert.most_recent_instance.location.end_line - 
                   alert.most_recent_instance.location.start_line;
      return sum + span;
    }, 0) / batch.alerts.length;

    let fileScore = 1.0;
    if (uniqueFiles.size === 1) {
      fileScore = 1.0;
    } else if (uniqueFiles.size <= 3) {
      fileScore = 0.8;
    } else if (uniqueFiles.size <= 5) {
      fileScore = 0.6;
    } else {
      fileScore = 0.4;
    }

    let lineScore = 1.0;
    if (avgLineSpan <= 5) {
      lineScore = 1.0;
    } else if (avgLineSpan <= 15) {
      lineScore = 0.8;
    } else if (avgLineSpan <= 30) {
      lineScore = 0.6;
    } else {
      lineScore = 0.4;
    }

    return (fileScore + lineScore) / 2;
  }

  private assessHistoricalPattern(batch: AlertBatch): number {
    if (!this.learningStore || this.learningStore.records.length === 0) {
      return 0.5;
    }

    const cwes = batch.alerts
      .flatMap(a => a.cwe || [])
      .filter((cwe, index, self) => self.indexOf(cwe) === index);

    if (cwes.length === 0) {
      return 0.5;
    }

    let totalScore = 0;
    let matchedCWEs = 0;

    for (const cwe of cwes) {
      const pattern = this.learningStore.patterns[cwe];
      
      if (pattern && pattern.totalAttempts >= 3) {
        totalScore += pattern.successRate;
        matchedCWEs++;
      }
    }

    if (matchedCWEs === 0) {
      return 0.5;
    }

    return totalScore / matchedCWEs;
  }

  private explainCodeQLValidation(score: number): string {
    if (score >= 0.9) {
      return 'CodeQL validation passed, confirming the vulnerability is fixed.';
    } else if (score >= 0.6) {
      return 'CodeQL validation in progress or not yet available.';
    } else if (score >= 0.3) {
      return 'CodeQL validation shows potential issues with the fix.';
    } else {
      return 'CodeQL validation failed, the vulnerability may not be fully addressed.';
    }
  }

  private explainTestCoverage(score: number): string {
    if (score >= 0.9) {
      return 'All tests passing.';
    } else if (score >= 0.6) {
      return 'Most tests passing.';
    } else if (score >= 0.3) {
      return 'Some tests failing, review recommended.';
    } else {
      return 'Tests failing or no test coverage detected.';
    }
  }

  private explainChangeScope(score: number): string {
    if (score >= 0.9) {
      return 'Changes are minimal and focused.';
    } else if (score >= 0.6) {
      return 'Changes are moderate in scope.';
    } else if (score >= 0.3) {
      return 'Changes span multiple files or are extensive.';
    } else {
      return 'Changes are very extensive, careful review recommended.';
    }
  }

  private explainHistoricalPattern(score: number): string {
    if (!this.learningStore || this.learningStore.records.length === 0) {
      return 'No historical data available for this vulnerability type.';
    }

    if (score >= 0.9) {
      return 'Historical fixes for this vulnerability type have high success rate.';
    } else if (score >= 0.6) {
      return 'Historical fixes for this vulnerability type have moderate success rate.';
    } else if (score >= 0.3) {
      return 'Historical fixes for this vulnerability type have mixed results.';
    } else {
      return 'Historical fixes for this vulnerability type have low success rate, extra review recommended.';
    }
  }

  shouldAutoMerge(signals: ConfidenceSignals, threshold: number): boolean {
    return signals.overall >= threshold && signals.codeqlValidation >= 0.9;
  }

  needsHumanReview(signals: ConfidenceSignals, minThreshold: number): boolean {
    return signals.overall < minThreshold || signals.codeqlValidation < 0.6;
  }

  generateReviewRecommendation(signals: ConfidenceSignals): string {
    const recommendations: string[] = [];

    if (signals.codeqlValidation < 0.6) {
      recommendations.push('- Verify that the CodeQL vulnerability is actually fixed');
    }

    if (signals.testCoverage < 0.6) {
      recommendations.push('- Run additional tests to ensure functionality is preserved');
    }

    if (signals.changeScope < 0.6) {
      recommendations.push('- Review the scope of changes for unintended side effects');
    }

    if (signals.historicalPattern < 0.6) {
      recommendations.push('- This vulnerability type has had mixed fix success historically');
    }

    if (recommendations.length === 0) {
      return 'No specific review recommendations. Fix appears solid.';
    }

    return 'Review Recommendations:\n' + recommendations.join('\n');
  }
}
