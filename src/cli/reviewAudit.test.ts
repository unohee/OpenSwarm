import { describe, it, expect } from 'vitest';
import {
  filterSourceFiles,
  preferSrcRoot,
  partitionIntoAreas,
  aggregateAuditResults,
  runMaxReview,
  type AuditArea,
  type AuditAreaResult,
  type AuditProgress,
} from './reviewAudit.js';
import type { ReviewResult } from '../agents/agentPair.js';

describe('filterSourceFiles (INT-2006)', () => {
  it('keeps source extensions and drops the rest', () => {
    const out = filterSourceFiles(['src/a.ts', 'src/b.tsx', 'README.md', 'logo.png', 'data.json']);
    expect(out).toEqual(['src/a.ts', 'src/b.tsx']);
  });

  it('excludes test and spec files', () => {
    const out = filterSourceFiles(['src/a.ts', 'src/a.test.ts', 'src/b.spec.tsx', 'src/m_test.py']);
    expect(out).toEqual(['src/a.ts']);
  });

  it('excludes tracked junk directories', () => {
    const out = filterSourceFiles(['src/a.ts', 'dist/a.js', 'trash/old.ts', '.openswarm/x.ts']);
    expect(out).toEqual(['src/a.ts']);
  });
});

describe('preferSrcRoot (INT-2006)', () => {
  it('keeps only src/ files when any exist', () => {
    expect(preferSrcRoot(['src/a.ts', 'benchmarks/b.ts', 'scripts/c.ts', 'index.ts'])).toEqual(['src/a.ts']);
  });

  it('falls back to all files when there is no src/ root', () => {
    const files = ['lib/a.ts', 'app/b.ts'];
    expect(preferSrcRoot(files)).toEqual(files);
  });
});

describe('partitionIntoAreas (INT-2006)', () => {
  it('groups one area per directory, sorted', () => {
    const areas = partitionIntoAreas(['src/b/y.ts', 'src/a/x.ts', 'src/a/w.ts']);
    expect(areas.map((a) => a.label)).toEqual(['src/a', 'src/b']);
    expect(areas[0].files).toEqual(['src/a/w.ts', 'src/a/x.ts']); // sorted within
  });

  it('splits an oversized directory into numbered chunks', () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/big/f${String(i).padStart(2, '0')}.ts`);
    const areas = partitionIntoAreas(files, 10);
    expect(areas.map((a) => a.label)).toEqual(['src/big (1/3)', 'src/big (2/3)', 'src/big (3/3)']);
    expect(areas[0].files).toHaveLength(10);
    expect(areas[2].files).toHaveLength(5);
    // every file lands in exactly one chunk
    expect(areas.flatMap((a) => a.files).sort()).toEqual(files);
  });

  it('keeps a directory at the cap as a single area', () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/m/f${i}.ts`);
    const areas = partitionIntoAreas(files, 12);
    expect(areas).toHaveLength(1);
    expect(areas[0].label).toBe('src/m');
  });

  it('is deterministic across input orderings', () => {
    const a = partitionIntoAreas(['src/b/y.ts', 'src/a/x.ts']);
    const b = partitionIntoAreas(['src/a/x.ts', 'src/b/y.ts']);
    expect(a).toEqual(b);
  });
});

describe('aggregateAuditResults (INT-2006)', () => {
  const review = (over: Partial<ReviewResult>): ReviewResult => ({
    decision: 'approve',
    feedback: '',
    ...over,
  });
  const area = (label: string) => ({ label, dir: label, files: [`${label}/f.ts`] });

  it('rolls up to the worst decision (reject > revise > approve)', () => {
    const results: AuditAreaResult[] = [
      { area: area('a'), review: review({ decision: 'approve' }) },
      { area: area('b'), review: review({ decision: 'revise' }) },
      { area: area('c'), review: review({ decision: 'reject' }) },
    ];
    expect(aggregateAuditResults(results).decision).toBe('reject');
  });

  it('approves only when every area approves', () => {
    const results: AuditAreaResult[] = [
      { area: area('a'), review: review({ decision: 'approve' }) },
      { area: area('b'), review: review({ decision: 'approve' }) },
    ];
    expect(aggregateAuditResults(results).decision).toBe('approve');
  });

  it('counts errored areas without letting them affect the verdict', () => {
    const results: AuditAreaResult[] = [
      { area: area('a'), review: review({ decision: 'approve' }) },
      { area: area('b'), error: 'subagent timed out' },
    ];
    const sum = aggregateAuditResults(results);
    expect(sum.decision).toBe('approve');
    expect(sum.completed).toBe(1);
    expect(sum.failed).toBe(1);
    expect(sum.areas.find((a) => a.label === 'b')?.decision).toBe('error');
  });

  it('prefixes issues and folds the area into action locations', () => {
    const results: AuditAreaResult[] = [
      {
        area: area('src/auth'),
        review: review({
          decision: 'revise',
          issues: ['missing null check'],
          recommendedActions: [
            { type: 'bug', title: 'Fix token refresh', location: 'token.ts:42' },
            { type: 'test', title: 'Add coverage' },
          ],
        }),
      },
    ];
    const sum = aggregateAuditResults(results);
    expect(sum.issues).toEqual(['[src/auth] missing null check']);
    expect(sum.recommendedActions[0].location).toBe('src/auth: token.ts:42');
    expect(sum.recommendedActions[1].location).toBe('src/auth'); // no original location
  });
});

describe('runMaxReview orchestration (INT-2006)', () => {
  const mkAreas = (n: number): AuditArea[] =>
    Array.from({ length: n }, (_, i) => ({ label: `src/m${i}`, dir: `src/m${i}`, files: [`src/m${i}/f.ts`] }));

  it('fans out over areas and aggregates the worst verdict', async () => {
    const areas = mkAreas(3);
    const review = async (area: AuditArea): Promise<ReviewResult> => ({
      decision: area.label === 'src/m1' ? 'reject' : 'approve',
      feedback: '',
      issues: [`issue in ${area.label}`],
    });
    const { summary: sum } = await runMaxReview(areas, '/repo', { concurrency: 2 }, { review });
    expect(sum.decision).toBe('reject');
    expect(sum.completed).toBe(3);
    expect(sum.issues).toContain('[src/m1] issue in src/m1');
  });

  it('emits start/done progress for every area', async () => {
    const areas = mkAreas(4);
    const events: AuditProgress[] = [];
    await runMaxReview(
      areas,
      '/repo',
      { concurrency: 2 },
      { review: async () => ({ decision: 'approve', feedback: '' }), onProgress: (e) => events.push(e) },
    );
    expect(events.filter((e) => e.type === 'start')).toHaveLength(4);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(4);
    const lastDone = [...events].reverse().find((e) => e.type === 'done');
    expect(lastDone && 'done' in lastDone && lastDone.done).toBe(4);
  });

  it('records a thrown subagent as an errored area without aborting', async () => {
    const areas = mkAreas(3);
    const review = async (area: AuditArea): Promise<ReviewResult> => {
      if (area.label === 'src/m1') throw new Error('subagent crashed');
      return { decision: 'approve', feedback: '' };
    };
    const { summary: sum } = await runMaxReview(areas, '/repo', { concurrency: 3 }, { review });
    expect(sum.completed).toBe(2);
    expect(sum.failed).toBe(1);
    expect(sum.areas.find((a) => a.label === 'src/m1')?.decision).toBe('error');
  });
});
