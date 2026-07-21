import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../knowledge/index.js', () => ({
  getGraph: vi.fn().mockResolvedValue(null),
  toProjectSlug: (path: string) => path,
}));
vi.mock('../memory/repoKnowledge.js', () => ({
  recallRepoKnowledge: vi.fn().mockResolvedValue([{ type: 'constraint', title: 'Use real deps', content: 'Do not stub packages.' }]),
  repoKey: (path: string) => path.replace(/\/worktree\/[^/]+\/?$/, ''),
}));

const { buildFixRepositoryContext, pathWithinScope, planFixUnits } = await import('./fixPlanning.js');
import type { FixRepositoryContext } from './fixPlanning.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function context(overrides: Partial<FixRepositoryContext> = {}): FixRepositoryContext {
  return {
    canonicalRoot: '/repo', packageManager: 'pnpm', workspaces: ['packages/*'],
    manifests: ['package.json', 'packages/app/package.json'], verificationCommands: ['pnpm test'],
    sharedPaths: ['node_modules'], repoMemories: [], dependencyGraphAvailable: true,
    dependencyMap: {}, preflight: { ready: true, issues: [] }, ...overrides,
  };
}

describe('buildFixRepositoryContext', () => {
  it('captures package-manager/verify context and blocks a missing installed Node runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openswarm-fix-context-'));
    roots.push(root);
    await writeFile(join(root, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@10.0.0', workspaces: ['packages/*'], devDependencies: { vitest: '^4' },
    }));
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const plan = {
      commands: [{ name: 'test', run: 'pnpm test', kind: 'test' as const }],
      packageJsonByDirectory: { '': '{}' },
    };

    const missing = await buildFixRepositoryContext(root, plan, 'fix review issue');
    expect(missing.packageManager).toBe('pnpm');
    expect(missing.workspaces).toEqual(['packages/*']);
    expect(missing.verificationCommands).toEqual(['pnpm test']);
    expect(missing.preflight.ready).toBe(false);
    expect(missing.preflight.issues.join('\n')).toContain('no node_modules');
    expect(missing.repoMemories[0]?.title).toBe('Use real deps');

    await mkdir(join(root, 'node_modules'));
    const ready = await buildFixRepositoryContext(root, plan, 'fix review issue');
    expect(ready.preflight).toEqual({ ready: true, issues: [] });
  });
});

describe('planFixUnits', () => {
  it('merges related areas and carries callers, tests, and the nearest manifest into scope', () => {
    const ctx = context({
      dependencyMap: {
        'packages/app/src/a.ts': {
          imports: ['packages/app/src/b.ts'],
          dependents: ['packages/app/src/caller.ts'],
          tests: ['packages/app/src/a.test.ts'],
        },
        'packages/app/src/b.ts': { imports: [], dependents: [], tests: [] },
        'src/independent.ts': { imports: [], dependents: [], tests: [] },
      },
    });
    const units = planFixUnits([
      { area: { label: 'app/a', dir: 'packages/app/src/a', files: ['packages/app/src/a.ts'] }, review: { decision: 'revise', feedback: '' } },
      { area: { label: 'app/b', dir: 'packages/app/src/b', files: ['packages/app/src/b.ts'] }, review: { decision: 'revise', feedback: '' } },
      { area: { label: 'independent', dir: 'src/independent', files: ['src/independent.ts'] }, review: { decision: 'revise', feedback: '' } },
    ], ctx);

    expect(units).toHaveLength(2);
    const related = units.find((unit) => unit.targetLabels.includes('app/a'))!;
    expect(related.targetLabels.sort()).toEqual(['app/a', 'app/b']);
    expect(related.dependencyFiles).toContain('packages/app/src/caller.ts');
    expect(related.testFiles).toContain('packages/app/src/a.test.ts');
    expect(related.manifestFiles).toEqual(['packages/app/package.json']);
    expect(related.allowedPaths).toContain('packages/app/src/caller.ts');
  });

  it('keeps independent areas separate and supports directory-or-file scope checks', () => {
    const units = planFixUnits([
      { area: { label: 'a', dir: 'src/a', files: ['src/a/x.ts'] }, review: { decision: 'revise', feedback: '' } },
      { area: { label: 'b', dir: 'src/b', files: ['src/b/y.ts'] }, review: { decision: 'revise', feedback: '' } },
    ], context());
    expect(units).toHaveLength(2);
    expect(pathWithinScope('src/a/new.test.ts', ['src/a'])).toBe(true);
    expect(pathWithinScope('src/ab/escape.ts', ['src/a'])).toBe(false);
  });
});
