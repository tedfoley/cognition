import { CodeQLAlert, AlertBatch, BatchingStrategy, Severity } from './types';

export class BatchingEngine {
  private strategy: BatchingStrategy;
  private maxBatchSize: number;

  constructor(strategy: BatchingStrategy, maxBatchSize: number) {
    this.strategy = strategy;
    this.maxBatchSize = maxBatchSize;
  }

  createBatches(alerts: CodeQLAlert[]): AlertBatch[] {
    switch (this.strategy) {
      case 'severity-then-cwe':
        return this.batchBySeverityThenCWE(alerts);
      case 'severity-only':
        return this.batchBySeverityOnly(alerts);
      case 'by-file':
        return this.batchByFile(alerts);
      case 'by-cwe':
        return this.batchByCWE(alerts);
      case 'by-complexity':
        return this.batchByComplexity(alerts);
      default:
        return this.batchBySeverityThenCWE(alerts);
    }
  }

  private batchBySeverityThenCWE(alerts: CodeQLAlert[]): AlertBatch[] {
    const severityOrder: Severity[] = ['critical', 'high', 'medium', 'low', 'warning', 'note', 'error'];
    const batches: AlertBatch[] = [];

    for (const severity of severityOrder) {
      const severityAlerts = alerts.filter(a => a.rule.severity === severity);
      
      if (severityAlerts.length === 0) continue;

      const cweGroups = this.groupByCWE(severityAlerts);
      
      for (const [cwe, cweAlerts] of Object.entries(cweGroups)) {
        const chunks = this.chunkArray(cweAlerts, this.maxBatchSize);
        
        for (let i = 0; i < chunks.length; i++) {
          batches.push({
            id: uuidv4(),
            alerts: chunks[i],
            strategy: this.strategy,
            groupKey: `${severity}-${cwe}${chunks.length > 1 ? `-part${i + 1}` : ''}`,
            severity,
            priority: this.calculatePriority(severity, chunks[i].length),
            status: 'pending',
          });
        }
      }
    }

    return batches.sort((a, b) => b.priority - a.priority);
  }

  private batchBySeverityOnly(alerts: CodeQLAlert[]): AlertBatch[] {
    const severityOrder: Severity[] = ['critical', 'high', 'medium', 'low', 'warning', 'note', 'error'];
    const batches: AlertBatch[] = [];

    for (const severity of severityOrder) {
      const severityAlerts = alerts.filter(a => a.rule.severity === severity);
      
      if (severityAlerts.length === 0) continue;

      const chunks = this.chunkArray(severityAlerts, this.maxBatchSize);
      
      for (let i = 0; i < chunks.length; i++) {
        batches.push({
          id: uuidv4(),
          alerts: chunks[i],
          strategy: this.strategy,
          groupKey: `${severity}${chunks.length > 1 ? `-part${i + 1}` : ''}`,
          severity,
          priority: this.calculatePriority(severity, chunks[i].length),
          status: 'pending',
        });
      }
    }

    return batches.sort((a, b) => b.priority - a.priority);
  }

  private batchByFile(alerts: CodeQLAlert[]): AlertBatch[] {
    const fileGroups: Record<string, CodeQLAlert[]> = {};
    
    for (const alert of alerts) {
      const filePath = alert.most_recent_instance.location.path;
      const directory = filePath.split('/').slice(0, -1).join('/') || '/';
      
      if (!fileGroups[directory]) {
        fileGroups[directory] = [];
      }
      fileGroups[directory].push(alert);
    }

    const batches: AlertBatch[] = [];
    
    for (const [directory, dirAlerts] of Object.entries(fileGroups)) {
      const sortedAlerts = this.sortBySeverity(dirAlerts);
      const chunks = this.chunkArray(sortedAlerts, this.maxBatchSize);
      
      for (let i = 0; i < chunks.length; i++) {
        const highestSeverity = this.getHighestSeverity(chunks[i]);
        batches.push({
          id: uuidv4(),
          alerts: chunks[i],
          strategy: this.strategy,
          groupKey: `${directory}${chunks.length > 1 ? `-part${i + 1}` : ''}`,
          severity: highestSeverity,
          priority: this.calculatePriority(highestSeverity, chunks[i].length),
          status: 'pending',
        });
      }
    }

    return batches.sort((a, b) => b.priority - a.priority);
  }

  private batchByCWE(alerts: CodeQLAlert[]): AlertBatch[] {
    const cweGroups = this.groupByCWE(alerts);
    const batches: AlertBatch[] = [];

    for (const [cwe, cweAlerts] of Object.entries(cweGroups)) {
      const sortedAlerts = this.sortBySeverity(cweAlerts);
      const chunks = this.chunkArray(sortedAlerts, this.maxBatchSize);
      
      for (let i = 0; i < chunks.length; i++) {
        const highestSeverity = this.getHighestSeverity(chunks[i]);
        batches.push({
          id: uuidv4(),
          alerts: chunks[i],
          strategy: this.strategy,
          groupKey: `${cwe}${chunks.length > 1 ? `-part${i + 1}` : ''}`,
          severity: highestSeverity,
          priority: this.calculatePriority(highestSeverity, chunks[i].length),
          status: 'pending',
        });
      }
    }

    return batches.sort((a, b) => b.priority - a.priority);
  }

  private batchByComplexity(alerts: CodeQLAlert[]): AlertBatch[] {
    const complexityGroups: Record<string, CodeQLAlert[]> = {
      simple: [],
      moderate: [],
      complex: [],
    };

    for (const alert of alerts) {
      const complexity = this.estimateComplexity(alert);
      complexityGroups[complexity].push(alert);
    }

    const batches: AlertBatch[] = [];
    const complexityOrder = ['simple', 'moderate', 'complex'];

    for (const complexity of complexityOrder) {
      const complexityAlerts = complexityGroups[complexity];
      
      if (complexityAlerts.length === 0) continue;

      const sortedAlerts = this.sortBySeverity(complexityAlerts);
      const chunks = this.chunkArray(sortedAlerts, this.maxBatchSize);
      
      for (let i = 0; i < chunks.length; i++) {
        const highestSeverity = this.getHighestSeverity(chunks[i]);
        batches.push({
          id: uuidv4(),
          alerts: chunks[i],
          strategy: this.strategy,
          groupKey: `${complexity}${chunks.length > 1 ? `-part${i + 1}` : ''}`,
          severity: highestSeverity,
          priority: this.calculatePriority(highestSeverity, chunks[i].length, complexity),
          status: 'pending',
        });
      }
    }

    return batches.sort((a, b) => b.priority - a.priority);
  }

  private groupByCWE(alerts: CodeQLAlert[]): Record<string, CodeQLAlert[]> {
    const groups: Record<string, CodeQLAlert[]> = {};
    
    for (const alert of alerts) {
      const cwe = alert.cwe?.[0] || 'UNKNOWN';
      
      if (!groups[cwe]) {
        groups[cwe] = [];
      }
      groups[cwe].push(alert);
    }

    return groups;
  }

  private sortBySeverity(alerts: CodeQLAlert[]): CodeQLAlert[] {
    const severityOrder: Record<Severity, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
      warning: 4,
      note: 5,
      error: 1,
    };

    return [...alerts].sort((a, b) => 
      severityOrder[a.rule.severity] - severityOrder[b.rule.severity]
    );
  }

  private getHighestSeverity(alerts: CodeQLAlert[]): Severity {
    const severityOrder: Severity[] = ['critical', 'high', 'medium', 'low', 'warning', 'note', 'error'];
    
    for (const severity of severityOrder) {
      if (alerts.some(a => a.rule.severity === severity)) {
        return severity;
      }
    }
    
    return 'medium';
  }

  private calculatePriority(severity: Severity, alertCount: number, complexity?: string): number {
    const severityScore: Record<Severity, number> = {
      critical: 100,
      high: 80,
      medium: 60,
      low: 40,
      warning: 20,
      note: 10,
      error: 80,
    };

    let priority = severityScore[severity];
    
    priority += Math.min(alertCount * 2, 20);
    
    if (complexity) {
      const complexityBonus: Record<string, number> = {
        simple: 15,
        moderate: 5,
        complex: -10,
      };
      priority += complexityBonus[complexity] || 0;
    }

    return priority;
  }

  private estimateComplexity(alert: CodeQLAlert): 'simple' | 'moderate' | 'complex' {
    const simplePatterns = [
      'CWE-79',
      'CWE-89',
      'CWE-22',
      'CWE-78',
    ];
    
    const complexPatterns = [
      'CWE-362',
      'CWE-416',
      'CWE-119',
      'CWE-190',
    ];

    const cwe = alert.cwe?.[0] || '';
    
    if (simplePatterns.some(p => cwe.includes(p))) {
      return 'simple';
    }
    
    if (complexPatterns.some(p => cwe.includes(p))) {
      return 'complex';
    }

    const lineSpan = alert.most_recent_instance.location.end_line - 
                     alert.most_recent_instance.location.start_line;
    
    if (lineSpan <= 5) return 'simple';
    if (lineSpan <= 20) return 'moderate';
    return 'complex';
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    
    return chunks;
  }

  rebatch(batches: AlertBatch[], newStrategy: BatchingStrategy): AlertBatch[] {
    const allAlerts = batches.flatMap(b => b.alerts);
    
    const engine = new BatchingEngine(newStrategy, this.maxBatchSize);
    return engine.createBatches(allAlerts);
  }

  prioritizeBatch(batches: AlertBatch[], batchId: string, newPriority: number): AlertBatch[] {
    return batches.map(batch => {
      if (batch.id === batchId) {
        return { ...batch, priority: newPriority };
      }
      return batch;
    }).sort((a, b) => b.priority - a.priority);
  }

  skipBatch(batches: AlertBatch[], batchId: string): AlertBatch[] {
    return batches.filter(b => b.id !== batchId);
  }

  getBatchSummary(batches: AlertBatch[]): {
    totalBatches: number;
    totalAlerts: number;
    bySeverity: Record<Severity, number>;
    byStatus: Record<string, number>;
  } {
    const summary = {
      totalBatches: batches.length,
      totalAlerts: batches.reduce((sum, b) => sum + b.alerts.length, 0),
      bySeverity: {} as Record<Severity, number>,
      byStatus: {} as Record<string, number>,
    };

    for (const batch of batches) {
      summary.bySeverity[batch.severity] = (summary.bySeverity[batch.severity] || 0) + batch.alerts.length;
      summary.byStatus[batch.status] = (summary.byStatus[batch.status] || 0) + 1;
    }

    return summary;
  }
}

function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
