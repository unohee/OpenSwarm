import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGuards } from './pipelineGuards.js';
import type { WorkerResult } from './agentPair.js';

function mockWorker(filesChanged: string[] = []): WorkerResult {
  return { success: true, summary: '', filesChanged, commands: [], output: '' };
}

function guardIssues(results: Awaited<ReturnType<typeof runGuards>>, guard: string): string[] {
  return results.results.find(r => r.guard === guard)?.issues ?? [];
}

describe('pipelineGuards — INT-2388 deterministic guards', () => {
  let repo: string;

  beforeEach(() => {
    repo = join(tmpdir(), `openswarm-guards-${process.pid}-${Date.now()}`);
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
    writeFileSync(join(repo, 'base.ts'), 'export const base = 1;\n');
    execFileSync('git', ['add', 'base.ts'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });
  });

  afterEach(() => {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  describe('deadModuleCheck', () => {
    it('flags a new source module that nothing imports', async () => {
      writeFileSync(join(repo, 'orphanwidget.ts'), 'export function orphanwidget() { return 1; }\n');
      const res = await runGuards(mockWorker(), repo, { deadModuleCheck: true });
      const issues = guardIssues(res, 'deadModule');
      expect(issues.some(i => i.includes('orphanwidget.ts'))).toBe(true);
      // non-blocking: overall still passes
      expect(res.allPassed).toBe(true);
    });

    it('does NOT flag a new module that an existing file imports', async () => {
      // A committed file references the new module by basename.
      writeFileSync(join(repo, 'caller.ts'), "import { helperthing } from './helperthing.js';\nexport const c = helperthing;\n");
      execFileSync('git', ['add', 'caller.ts'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'add caller'], { cwd: repo });
      // Now the new module appears (untracked); caller already imports it.
      writeFileSync(join(repo, 'helperthing.ts'), 'export const helperthing = 42;\n');
      const res = await runGuards(mockWorker(), repo, { deadModuleCheck: true });
      const issues = guardIssues(res, 'deadModule');
      expect(issues.some(i => i.includes('helperthing.ts'))).toBe(false);
    });

    it('ignores new test files', async () => {
      writeFileSync(join(repo, 'somefeature.test.ts'), 'import { it } from "vitest"; it("x", () => {});\n');
      const res = await runGuards(mockWorker(), repo, { deadModuleCheck: true });
      const issues = guardIssues(res, 'deadModule');
      expect(issues.some(i => i.includes('somefeature.test.ts'))).toBe(false);
    });

    it('skips generic/short basenames to avoid grep noise', async () => {
      writeFileSync(join(repo, 'index.ts'), 'export const idx = 1;\n');
      const res = await runGuards(mockWorker(), repo, { deadModuleCheck: true });
      const issues = guardIssues(res, 'deadModule');
      expect(issues.some(i => i.includes('index.ts'))).toBe(false);
    });
  });

  describe('reformatCheck', () => {
    it('flags a whitespace-only change', async () => {
      writeFileSync(join(repo, 'base.ts'), '  export const base = 1;\n'); // re-indent only
      const res = await runGuards(mockWorker(), repo, { reformatCheck: true });
      const issues = guardIssues(res, 'reformatScope');
      expect(issues.some(i => i.includes('base.ts') && i.includes('reformat-only'))).toBe(true);
      expect(res.allPassed).toBe(true);
    });

    it('does NOT flag a semantic change', async () => {
      writeFileSync(join(repo, 'base.ts'), 'export const base = 999;\n');
      const res = await runGuards(mockWorker(), repo, { reformatCheck: true });
      const issues = guardIssues(res, 'reformatScope');
      expect(issues.length).toBe(0);
    });

    it('flags an oversized diff (tracked-line count)', async () => {
      // Large-diff uses tracked numstat; rewrite a committed file so the added
      // lines register (untracked new files count as 0 added — see guard note).
      const bigLine = 'export const v = 1;\n';
      writeFileSync(join(repo, 'base.ts'), bigLine.repeat(1300));
      const res = await runGuards(mockWorker(), repo, { reformatCheck: true });
      const issues = guardIssues(res, 'reformatScope');
      expect(issues.some(i => i.includes('Large diff'))).toBe(true);
    });
  });

  it('runs neither guard when disabled', async () => {
    writeFileSync(join(repo, 'orphanwidget.ts'), 'export const x = 1;\n');
    const res = await runGuards(mockWorker(), repo, {});
    expect(res.results.find(r => r.guard === 'deadModule')).toBeUndefined();
    expect(res.results.find(r => r.guard === 'reformatScope')).toBeUndefined();
  });
});
