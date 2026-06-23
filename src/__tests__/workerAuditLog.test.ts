// ============================================
// Worker audit log — comment formatting tests
// ============================================

import { describe, it, expect } from 'vitest';
import { buildWorkerStartComment, buildWorkerCompleteComment } from '../automation/workerAuditLog.js';
import type { WorkerResult } from '../agents/agentPair.js';

describe('workerAuditLog', () => {
  describe('buildWorkerStartComment', () => {
    it('includes task, goal, target files and effort', () => {
      const body = buildWorkerStartComment({
        attempt: 1,
        maxAttempts: 3,
        taskTitle: 'Add logout button',
        taskGoal: 'Wire a logout action into the header',
        targetFiles: ['src/header.tsx', 'src/auth.ts'],
        model: 'claude-opus-4-8',
        maxTurns: 20,
      });

      expect(body).toContain('Worker instruction');
      expect(body).toContain('attempt #1/3');
      expect(body).toContain('Add logout button');
      expect(body).toContain('Wire a logout action');
      expect(body).toContain('`src/header.tsx`');
      expect(body).toContain('claude-opus-4-8');
      expect(body).toContain('Max turns 20');
      // Convention: no decorative emoji in comment bodies.
      expect(body).not.toMatch(/[🛠️🤖✅❌⚠️📋]/u);
    });

    it('labels revisions and survives missing optional fields', () => {
      const body = buildWorkerStartComment({
        attempt: 2,
        taskTitle: 'Fix flaky test',
        isRevision: true,
      });

      expect(body).toContain('Worker revision');
      expect(body).toContain('attempt #2');
      expect(body).not.toContain('Target files');
      expect(body).not.toContain('Effort');
    });

    it('caps long target file lists with a "+N more" suffix', () => {
      const files = Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`);
      const body = buildWorkerStartComment({ attempt: 1, taskTitle: 't', targetFiles: files });
      expect(body).toContain('more_');
    });
  });

  describe('buildWorkerCompleteComment', () => {
    const base: WorkerResult = {
      success: true,
      summary: 'Implemented the endpoint',
      filesChanged: ['src/api.ts'],
      commands: ['npm test'],
      output: '',
    };

    it('reports actions for a successful run', () => {
      const body = buildWorkerCompleteComment({
        attempt: 1,
        maxAttempts: 3,
        result: { ...base, confidencePercent: 88 },
        durationSec: 75,
      });

      expect(body).toContain('Worker actions — Done');
      expect(body).toContain('Implemented the endpoint');
      expect(body).toContain('Files changed (1)');
      expect(body).toContain('`src/api.ts`');
      expect(body).toContain('Commands (1)');
      expect(body).toContain('88%');
      expect(body).toContain('1m 15s');
      expect(body).not.toMatch(/[🛠️🤖✅❌⚠️📋]/u);
    });

    it('surfaces halt reason with a warning verdict', () => {
      const body = buildWorkerCompleteComment({
        attempt: 2,
        result: { ...base, success: false, haltReason: 'Confidence too low' },
      });

      expect(body).toContain('Halted');
      expect(body).toContain('Halt reason');
      expect(body).toContain('Confidence too low');
    });

    it('marks failures and shows the error', () => {
      const body = buildWorkerCompleteComment({
        attempt: 1,
        result: { ...base, success: false, error: 'compile error' },
      });

      expect(body).toContain('Failed');
      expect(body).toContain('Error');
      expect(body).toContain('compile error');
    });
  });
});
