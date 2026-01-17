import {
  AlertBatch,
  PRDescription,
  ConfidenceSignals,
  DevinStructuredOutput,
  CodeQLAlert,
} from './types';

export class PRGenerator {
  private repository: string;

  constructor(repository: string) {
    this.repository = repository;
  }

  generatePRDescription(
    batch: AlertBatch,
    structuredOutput: DevinStructuredOutput | undefined,
    confidenceSignals: ConfidenceSignals | undefined,
    sessionUrl: string
  ): PRDescription {
    const title = this.generateTitle(batch);
    const body = this.generateBody(batch, structuredOutput, confidenceSignals, sessionUrl);
    const labels = this.generateLabels(batch, confidenceSignals);

    return { title, body, labels };
  }

  private generateTitle(batch: AlertBatch): string {
    const alertCount = batch.alerts.length;
    const cwe = this.getPrimaryCWE(batch);
    const severity = batch.severity.charAt(0).toUpperCase() + batch.severity.slice(1);

    if (cwe && cwe !== 'UNKNOWN') {
      return `fix(security): ${severity} ${cwe} vulnerabilities (${alertCount} alert${alertCount > 1 ? 's' : ''})`;
    }

    return `fix(security): ${severity} CodeQL alerts (${alertCount} alert${alertCount > 1 ? 's' : ''})`;
  }

  private generateBody(
    batch: AlertBatch,
    structuredOutput: DevinStructuredOutput | undefined,
    confidenceSignals: ConfidenceSignals | undefined,
    sessionUrl: string
  ): string {
    const sections: string[] = [];

    sections.push(this.generateSummarySection(batch));
    sections.push(this.generateAlertsSection(batch));
    
    if (structuredOutput?.fixes) {
      sections.push(this.generateFixesSection(structuredOutput));
    }
    
    if (confidenceSignals) {
      sections.push(this.generateConfidenceSection(confidenceSignals));
    }
    
    sections.push(this.generateReferencesSection(batch));
    sections.push(this.generateMetadataSection(batch, sessionUrl));

    return sections.join('\n\n');
  }

  private generateSummarySection(batch: AlertBatch): string {
    const alertCount = batch.alerts.length;
    const cwe = this.getPrimaryCWE(batch);
    const severity = batch.severity;

    let summary = `## Summary\n\n`;
    summary += `This PR addresses **${alertCount}** CodeQL security alert${alertCount > 1 ? 's' : ''}`;
    
    if (cwe && cwe !== 'UNKNOWN') {
      summary += ` related to **${cwe}**`;
    }
    
    summary += ` with **${severity}** severity.\n\n`;

    const cweDescription = this.getCWEDescription(cwe);
    if (cweDescription) {
      summary += `### Vulnerability Type\n\n${cweDescription}\n`;
    }

    return summary;
  }

  private generateAlertsSection(batch: AlertBatch): string {
    let section = `## Alerts Fixed\n\n`;
    section += `| # | Alert | File | Lines | Severity |\n`;
    section += `|---|-------|------|-------|----------|\n`;

    for (const alert of batch.alerts) {
      const location = alert.most_recent_instance.location;
      const lines = location.start_line === location.end_line 
        ? `L${location.start_line}` 
        : `L${location.start_line}-${location.end_line}`;
      
      section += `| [#${alert.number}](${alert.html_url}) | ${alert.rule.name} | \`${location.path}\` | ${lines} | ${alert.rule.severity} |\n`;
    }

    return section;
  }

  private generateFixesSection(structuredOutput: DevinStructuredOutput): string {
    const completedFixes = structuredOutput.fixes.filter(f => f.status === 'completed');
    
    if (completedFixes.length === 0) {
      return '';
    }

    let section = `## Changes Made\n\n`;

    for (const fix of completedFixes) {
      section += `### Alert #${fix.alertNumber}\n\n`;
      
      if (fix.explanation) {
        section += `**Explanation:** ${fix.explanation}\n\n`;
      }

      if (fix.originalCode && fix.fixedCode) {
        section += `<details>\n<summary>View code changes</summary>\n\n`;
        section += `**Before:**\n\`\`\`\n${fix.originalCode}\n\`\`\`\n\n`;
        section += `**After:**\n\`\`\`\n${fix.fixedCode}\n\`\`\`\n\n`;
        section += `</details>\n\n`;
      }

      if (fix.confidenceScore !== undefined) {
        const confidenceEmoji = fix.confidenceScore >= 0.8 ? '🟢' : 
                               fix.confidenceScore >= 0.6 ? '🟡' : '🔴';
        section += `**Fix Confidence:** ${confidenceEmoji} ${(fix.confidenceScore * 100).toFixed(0)}%\n\n`;
      }
    }

    return section;
  }

  private generateConfidenceSection(signals: ConfidenceSignals): string {
    let section = `## Confidence Assessment\n\n`;
    
    const overallEmoji = signals.overall >= 0.8 ? '🟢' : 
                        signals.overall >= 0.6 ? '🟡' : '🔴';
    
    section += `**Overall Confidence:** ${overallEmoji} **${(signals.overall * 100).toFixed(0)}%**\n\n`;
    section += `${signals.explanation}\n\n`;

    section += `### Signal Breakdown\n\n`;
    section += `| Signal | Score | Weight |\n`;
    section += `|--------|-------|--------|\n`;
    section += `| CodeQL Validation | ${this.formatScore(signals.codeqlValidation)} | 40% |\n`;
    section += `| Test Coverage | ${this.formatScore(signals.testCoverage)} | 20% |\n`;
    section += `| Change Scope | ${this.formatScore(signals.changeScope)} | 20% |\n`;
    section += `| Historical Pattern | ${this.formatScore(signals.historicalPattern)} | 20% |\n`;

    if (signals.overall < 0.7) {
      section += `\n### ⚠️ Review Recommended\n\n`;
      section += `This fix has a confidence score below 70%. Please review carefully before merging.\n`;
    }

    return section;
  }

  private generateReferencesSection(batch: AlertBatch): string {
    const cwes = this.getAllCWEs(batch);
    
    if (cwes.length === 0) {
      return '';
    }

    let section = `## Security References\n\n`;

    for (const cwe of cwes) {
      const cweNumber = cwe.replace('CWE-', '');
      section += `- [${cwe}](https://cwe.mitre.org/data/definitions/${cweNumber}.html)\n`;
    }

    return section;
  }

  private generateMetadataSection(batch: AlertBatch, sessionUrl: string): string {
    let section = `## Metadata\n\n`;
    section += `- **Batch ID:** \`${batch.id}\`\n`;
    section += `- **Strategy:** ${batch.strategy}\n`;
    section += `- **Group:** ${batch.groupKey}\n`;
    section += `- **Devin Session:** [View Session](${sessionUrl})\n`;
    section += `- **Generated by:** [CodeQL Remediation Orchestrator](https://github.com/your-org/codeql-remediation-orchestrator)\n`;

    return section;
  }

  private generateLabels(batch: AlertBatch, confidenceSignals: ConfidenceSignals | undefined): string[] {
    const labels: string[] = ['security', 'codeql', 'automated'];

    labels.push(`severity:${batch.severity}`);

    const cwe = this.getPrimaryCWE(batch);
    if (cwe && cwe !== 'UNKNOWN') {
      labels.push(cwe.toLowerCase());
    }

    if (confidenceSignals) {
      if (confidenceSignals.overall >= 0.8) {
        labels.push('high-confidence');
      } else if (confidenceSignals.overall < 0.6) {
        labels.push('needs-review');
      }
    }

    return labels;
  }

  private getPrimaryCWE(batch: AlertBatch): string {
    const cweCounts: Record<string, number> = {};
    
    for (const alert of batch.alerts) {
      for (const cwe of alert.cwe || ['UNKNOWN']) {
        cweCounts[cwe] = (cweCounts[cwe] || 0) + 1;
      }
    }

    const sorted = Object.entries(cweCounts).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] || 'UNKNOWN';
  }

  private getAllCWEs(batch: AlertBatch): string[] {
    const cwes = new Set<string>();
    
    for (const alert of batch.alerts) {
      for (const cwe of alert.cwe || []) {
        if (cwe !== 'UNKNOWN') {
          cwes.add(cwe);
        }
      }
    }

    return Array.from(cwes);
  }

  private getCWEDescription(cwe: string | undefined): string {
    if (!cwe || cwe === 'UNKNOWN') return '';

    const descriptions: Record<string, string> = {
      'CWE-79': 'Cross-site Scripting (XSS) - Improper neutralization of input during web page generation allows attackers to inject malicious scripts.',
      'CWE-89': 'SQL Injection - Improper neutralization of special elements used in SQL commands allows attackers to execute arbitrary SQL.',
      'CWE-22': 'Path Traversal - Improper limitation of pathname allows attackers to access files outside the intended directory.',
      'CWE-78': 'OS Command Injection - Improper neutralization of special elements used in OS commands allows attackers to execute arbitrary commands.',
      'CWE-94': 'Code Injection - Improper control of code generation allows attackers to execute arbitrary code.',
      'CWE-287': 'Improper Authentication - The software does not properly verify the identity of an actor.',
      'CWE-306': 'Missing Authentication - The software does not perform authentication for critical functions.',
      'CWE-352': 'Cross-Site Request Forgery (CSRF) - The application does not verify that requests were intentionally sent by the user.',
      'CWE-434': 'Unrestricted File Upload - The software allows upload of dangerous file types.',
      'CWE-502': 'Deserialization of Untrusted Data - The application deserializes untrusted data without verification.',
      'CWE-611': 'XXE - Improper restriction of XML external entity references.',
      'CWE-798': 'Hard-coded Credentials - The software contains hard-coded credentials.',
      'CWE-918': 'Server-Side Request Forgery (SSRF) - The server makes requests to unintended locations.',
    };

    return descriptions[cwe] || '';
  }

  private formatScore(score: number): string {
    const percentage = (score * 100).toFixed(0);
    const emoji = score >= 0.8 ? '🟢' : score >= 0.6 ? '🟡' : '🔴';
    return `${emoji} ${percentage}%`;
  }
}
