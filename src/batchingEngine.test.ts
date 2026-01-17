import { BatchingEngine } from './batchingEngine';
import { CodeQLAlert, Severity } from './types';

// Helper function to create mock alerts
function createMockAlert(overrides: Partial<{
  number: number;
  severity: Severity;
  cwe: string[];
  filePath: string;
  startLine: number;
  endLine: number;
  ruleName: string;
}>): CodeQLAlert {
  const {
    number = 1,
    severity = 'medium',
    cwe = ['CWE-79'],
    filePath = 'src/app.ts',
    startLine = 10,
    endLine = 15,
    ruleName = 'Test Rule',
  } = overrides;

  return {
    number,
    rule: {
      id: `rule-${number}`,
      name: ruleName,
      severity,
      description: 'Test description',
      tags: ['security'],
    },
    tool: {
      name: 'CodeQL',
      version: '2.0.0',
    },
    most_recent_instance: {
      ref: 'refs/heads/main',
      state: 'open',
      commit_sha: 'abc123',
      message: {
        text: 'Test message',
      },
      location: {
        path: filePath,
        start_line: startLine,
        end_line: endLine,
        start_column: 1,
        end_column: 10,
      },
    },
    state: 'open',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    html_url: `https://github.com/test/repo/security/code-scanning/${number}`,
    instances_url: `https://api.github.com/repos/test/repo/code-scanning/alerts/${number}/instances`,
    cwe,
  };
}

describe('BatchingEngine', () => {
  describe('createBatches', () => {
    it('should create batches using severity-then-cwe strategy by default', () => {
      const engine = new BatchingEngine('severity-then-cwe', 5);
      const alerts = [
        createMockAlert({ number: 1, severity: 'critical', cwe: ['CWE-89'] }),
        createMockAlert({ number: 2, severity: 'critical', cwe: ['CWE-89'] }),
        createMockAlert({ number: 3, severity: 'high', cwe: ['CWE-79'] }),
        createMockAlert({ number: 4, severity: 'medium', cwe: ['CWE-22'] }),
      ];

      const batches = engine.createBatches(alerts);

      expect(batches.length).toBeGreaterThan(0);
      // Critical alerts should be in first batch (highest priority)
      expect(batches[0].severity).toBe('critical');
    });

    it('should respect max batch size', () => {
      const engine = new BatchingEngine('severity-only', 2);
      const alerts = [
        createMockAlert({ number: 1, severity: 'critical' }),
        createMockAlert({ number: 2, severity: 'critical' }),
        createMockAlert({ number: 3, severity: 'critical' }),
        createMockAlert({ number: 4, severity: 'critical' }),
        createMockAlert({ number: 5, severity: 'critical' }),
      ];

      const batches = engine.createBatches(alerts);

      // With 5 alerts and max batch size of 2, we should have 3 batches
      expect(batches.length).toBe(3);
      batches.forEach(batch => {
        expect(batch.alerts.length).toBeLessThanOrEqual(2);
      });
    });

    it('should group alerts by CWE in severity-then-cwe strategy', () => {
      const engine = new BatchingEngine('severity-then-cwe', 10);
      const alerts = [
        createMockAlert({ number: 1, severity: 'high', cwe: ['CWE-89'] }),
        createMockAlert({ number: 2, severity: 'high', cwe: ['CWE-89'] }),
        createMockAlert({ number: 3, severity: 'high', cwe: ['CWE-79'] }),
      ];

      const batches = engine.createBatches(alerts);

      // Should have 2 batches: one for CWE-89, one for CWE-79
      expect(batches.length).toBe(2);
      
      const cwe89Batch = batches.find(b => b.groupKey.includes('CWE-89'));
      const cwe79Batch = batches.find(b => b.groupKey.includes('CWE-79'));
      
      expect(cwe89Batch?.alerts.length).toBe(2);
      expect(cwe79Batch?.alerts.length).toBe(1);
    });
  });

  describe('batchByFile strategy', () => {
    it('should group alerts by directory', () => {
      const engine = new BatchingEngine('by-file', 10);
      const alerts = [
        createMockAlert({ number: 1, filePath: 'src/controllers/auth.ts' }),
        createMockAlert({ number: 2, filePath: 'src/controllers/user.ts' }),
        createMockAlert({ number: 3, filePath: 'src/models/user.ts' }),
      ];

      const batches = engine.createBatches(alerts);

      // Should have 2 batches: one for src/controllers, one for src/models
      expect(batches.length).toBe(2);
    });
  });

  describe('batchByCWE strategy', () => {
    it('should group all alerts by CWE regardless of severity', () => {
      const engine = new BatchingEngine('by-cwe', 10);
      const alerts = [
        createMockAlert({ number: 1, severity: 'critical', cwe: ['CWE-89'] }),
        createMockAlert({ number: 2, severity: 'low', cwe: ['CWE-89'] }),
        createMockAlert({ number: 3, severity: 'high', cwe: ['CWE-79'] }),
      ];

      const batches = engine.createBatches(alerts);

      // Should have 2 batches: one for CWE-89, one for CWE-79
      expect(batches.length).toBe(2);
      
      const cwe89Batch = batches.find(b => b.groupKey.includes('CWE-89'));
      expect(cwe89Batch?.alerts.length).toBe(2);
    });
  });

  describe('batchByComplexity strategy', () => {
    it('should group alerts by estimated complexity', () => {
      const engine = new BatchingEngine('by-complexity', 10);
      const alerts = [
        // Simple: CWE-79 (XSS) is in simplePatterns
        createMockAlert({ number: 1, cwe: ['CWE-79'], startLine: 10, endLine: 12 }),
        // Complex: CWE-362 (race condition) is in complexPatterns
        createMockAlert({ number: 2, cwe: ['CWE-362'], startLine: 10, endLine: 50 }),
        // Moderate: unknown CWE with moderate line span
        createMockAlert({ number: 3, cwe: ['CWE-999'], startLine: 10, endLine: 25 }),
      ];

      const batches = engine.createBatches(alerts);

      expect(batches.length).toBe(3);
      
      // Simple batches should have higher priority
      const simpleBatch = batches.find(b => b.groupKey === 'simple');
      const complexBatch = batches.find(b => b.groupKey === 'complex');
      
      expect(simpleBatch).toBeDefined();
      expect(complexBatch).toBeDefined();
      expect(simpleBatch!.priority).toBeGreaterThan(complexBatch!.priority);
    });
  });

  describe('priority calculation', () => {
    it('should assign higher priority to critical alerts', () => {
      const engine = new BatchingEngine('severity-only', 10);
      const alerts = [
        createMockAlert({ number: 1, severity: 'critical' }),
        createMockAlert({ number: 2, severity: 'low' }),
      ];

      const batches = engine.createBatches(alerts);

      const criticalBatch = batches.find(b => b.severity === 'critical');
      const lowBatch = batches.find(b => b.severity === 'low');

      expect(criticalBatch!.priority).toBeGreaterThan(lowBatch!.priority);
    });

    it('should give bonus priority for more alerts in a batch', () => {
      const engine = new BatchingEngine('severity-only', 10);
      const alerts = [
        createMockAlert({ number: 1, severity: 'high' }),
        createMockAlert({ number: 2, severity: 'high' }),
        createMockAlert({ number: 3, severity: 'high' }),
        createMockAlert({ number: 4, severity: 'medium' }),
      ];

      const batches = engine.createBatches(alerts);

      const highBatch = batches.find(b => b.severity === 'high');
      const mediumBatch = batches.find(b => b.severity === 'medium');

      // High batch has 3 alerts, medium has 1
      // High base: 80, Medium base: 60
      // High with bonus: 80 + 6 = 86, Medium with bonus: 60 + 2 = 62
      expect(highBatch!.priority).toBeGreaterThan(mediumBatch!.priority);
    });
  });

  describe('rebatch', () => {
    it('should rebatch alerts with a new strategy', () => {
      const engine = new BatchingEngine('severity-only', 10);
      const alerts = [
        createMockAlert({ number: 1, severity: 'high', cwe: ['CWE-89'] }),
        createMockAlert({ number: 2, severity: 'high', cwe: ['CWE-79'] }),
      ];

      const originalBatches = engine.createBatches(alerts);
      // severity-only should create 1 batch with both alerts
      expect(originalBatches.length).toBe(1);

      const rebatchedBatches = engine.rebatch(originalBatches, 'by-cwe');
      // by-cwe should create 2 batches (one per CWE)
      expect(rebatchedBatches.length).toBe(2);
    });
  });

  describe('prioritizeBatch', () => {
    it('should update batch priority and re-sort', () => {
      const engine = new BatchingEngine('severity-only', 10);
      const alerts = [
        createMockAlert({ number: 1, severity: 'critical' }),
        createMockAlert({ number: 2, severity: 'low' }),
      ];

      const batches = engine.createBatches(alerts);
      const lowBatch = batches.find(b => b.severity === 'low')!;
      
      // Give low batch very high priority
      const updatedBatches = engine.prioritizeBatch(batches, lowBatch.id, 1000);
      
      // Low batch should now be first
      expect(updatedBatches[0].id).toBe(lowBatch.id);
    });
  });

  describe('skipBatch', () => {
    it('should remove a batch from the list', () => {
      const engine = new BatchingEngine('severity-only', 10);
      const alerts = [
        createMockAlert({ number: 1, severity: 'critical' }),
        createMockAlert({ number: 2, severity: 'low' }),
      ];

      const batches = engine.createBatches(alerts);
      const batchToSkip = batches[0];
      
      const updatedBatches = engine.skipBatch(batches, batchToSkip.id);
      
      expect(updatedBatches.length).toBe(batches.length - 1);
      expect(updatedBatches.find(b => b.id === batchToSkip.id)).toBeUndefined();
    });
  });

  describe('getBatchSummary', () => {
    it('should return correct summary statistics', () => {
      const engine = new BatchingEngine('severity-only', 10);
      const alerts = [
        createMockAlert({ number: 1, severity: 'critical' }),
        createMockAlert({ number: 2, severity: 'critical' }),
        createMockAlert({ number: 3, severity: 'high' }),
        createMockAlert({ number: 4, severity: 'medium' }),
      ];

      const batches = engine.createBatches(alerts);
      const summary = engine.getBatchSummary(batches);

      expect(summary.totalBatches).toBe(3); // critical, high, medium
      expect(summary.totalAlerts).toBe(4);
      expect(summary.bySeverity.critical).toBe(2);
      expect(summary.bySeverity.high).toBe(1);
      expect(summary.bySeverity.medium).toBe(1);
      expect(summary.byStatus.pending).toBe(3);
    });
  });

  describe('edge cases', () => {
    it('should handle empty alerts array', () => {
      const engine = new BatchingEngine('severity-then-cwe', 5);
      const batches = engine.createBatches([]);
      expect(batches).toEqual([]);
    });

    it('should handle alerts without CWE', () => {
      const engine = new BatchingEngine('by-cwe', 10);
      const alert = createMockAlert({ number: 1 });
      alert.cwe = undefined;

      const batches = engine.createBatches([alert]);

      expect(batches.length).toBe(1);
      expect(batches[0].groupKey).toContain('UNKNOWN');
    });

    it('should handle single alert', () => {
      const engine = new BatchingEngine('severity-then-cwe', 5);
      const alerts = [createMockAlert({ number: 1 })];

      const batches = engine.createBatches(alerts);

      expect(batches.length).toBe(1);
      expect(batches[0].alerts.length).toBe(1);
    });
  });
});
