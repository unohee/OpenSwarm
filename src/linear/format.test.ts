import { describe, it, expect } from 'vitest';
import {
  isoDate,
  codeRef,
  formatAutomationComment,
  formatIssueDescription,
  formatTaskDescription,
} from './format.js';

describe('linear/format', () => {
  describe('isoDate', () => {
    it('renders an absolute YYYY-MM-DD date', () => {
      expect(isoDate(new Date('2026-06-23T13:33:00Z'))).toBe('2026-06-23');
    });
  });

  describe('codeRef', () => {
    it('joins file and line, or returns the path alone', () => {
      expect(codeRef('src/a.ts', 42)).toBe('src/a.ts:42');
      expect(codeRef('src/a.ts')).toBe('src/a.ts');
    });
  });

  describe('formatAutomationComment', () => {
    it('leads with a bold heading and a quiet italic sign-off with an absolute date', () => {
      const body = formatAutomationComment({
        heading: 'Task complete',
        date: new Date('2026-06-23T00:00:00Z'),
      });
      expect(body.startsWith('**Task complete**')).toBe(true);
      expect(body).toContain('_via OpenSwarm · 2026-06-23_');
    });

    it('keeps short facts inline and renders lists as bullets', () => {
      const body = formatAutomationComment({
        heading: 'Revision requested',
        summary: 'Worker will revise.',
        sections: [
          { label: 'Feedback', body: 'Fix the null guard' },
          { label: 'Issues', body: ['missing test', 'wrong path'] },
        ],
      });
      expect(body).toContain('**Feedback:** Fix the null guard');
      expect(body).toContain('**Issues:**\n- missing test\n- wrong path');
    });

    it('drops empty sections and empty meta values', () => {
      const body = formatAutomationComment({
        heading: 'Work complete',
        sections: [{ label: 'Empty', body: [] }, { label: 'Kept', body: 'x' }],
        meta: { Agent: 'main', Skipped: undefined, Blank: '' },
      });
      expect(body).not.toContain('**Empty');
      expect(body).toContain('**Kept:** x');
      expect(body).toContain('Agent main');
      expect(body).not.toContain('Skipped');
      expect(body).not.toContain('Blank');
    });

    it('uses a custom attribution and carries no decorative emoji', () => {
      const body = formatAutomationComment({
        heading: 'Task complete',
        sections: [{ label: 'Reviewer', body: 'looks good' }],
        attribution: 'Worker/Reviewer/Tester pipeline',
      });
      expect(body).toContain('_Worker/Reviewer/Tester pipeline ·');
      expect(body).not.toMatch(/[🤖✅❌⚠️📋🔨🧪]/u);
    });
  });

  describe('formatIssueDescription', () => {
    it('emits Problem/Cause/Solution/Verification in order, omitting empties', () => {
      const body = formatIssueDescription({
        problem: 'crashes on start',
        solution: 'guard the null',
      });
      expect(body).toBe('**Problem** — crashes on start\n\n**Solution** — guard the null');
      expect(body).not.toContain('Cause');
    });
  });

  describe('formatTaskDescription', () => {
    it('builds summary + scannable facts + attribution footer', () => {
      const body = formatTaskDescription({
        summary: 'Add a logout button',
        dependsOn: ['INT-100'],
        fileScope: ['src/header.tsx'],
        estimateMinutes: 20,
        parentTitle: 'Auth epic',
      });
      expect(body.startsWith('Add a logout button')).toBe(true);
      expect(body).toContain('- Depends on: INT-100');
      expect(body).toContain('- File scope: src/header.tsx');
      expect(body).toContain('- Estimate: 20 min');
      expect(body).toContain('_Split out from "Auth epic" during planning._');
    });

    it('omits optional blocks when absent', () => {
      const body = formatTaskDescription({ summary: 'Just do it' });
      expect(body).toBe('Just do it');
    });
  });
});
