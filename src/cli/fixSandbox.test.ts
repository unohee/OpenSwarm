import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promoteValidatedFiles } from '../agents/workerFanout.js';
import { runIsolatedFixBatch } from './fixSandbox.js';

describe('runIsolatedFixBatch', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'openswarm-fix-sandbox-'));
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
    await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(repo, 'src', 'b.ts'), 'export const b = 1;\n');
    await writeFile(join(repo, 'src', 'shared.ts'), 'export const shared = 1;\n');
    await mkdir(join(repo, 'node_modules'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'base'], { cwd: repo });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('runs independent units concurrently in isolated clones and promotes both disjoint diffs', async () => {
    let active = 0;
    let maxActive = 0;
    let releaseBoth!: () => void;
    const bothActive = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const results = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 2,
      items: [
        { label: 'a', allowedPaths: ['src/a.ts'] },
        { label: 'b', allowedPaths: ['src/b.ts'] },
      ],
      run: async (item, sandbox) => {
        active++;
        maxActive = Math.max(maxActive, active);
        if (active === 2) releaseBoth();
        await bothActive;
        await writeFile(join(sandbox, item.allowedPaths[0]), `export const ${item.label} = 2;\n`);
        active--;
        return { success: true };
      },
    });

    expect(maxActive).toBe(2);
    expect(results.every((result) => result.success)).toBe(true);
    expect(await readFile(join(repo, 'src', 'a.ts'), 'utf8')).toContain('= 2');
    expect(await readFile(join(repo, 'src', 'b.ts'), 'utf8')).toContain('= 2');
  });

  it('rejects the whole unit when its diff mixes allowed and out-of-scope files', async () => {
    const [result] = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 1,
      items: [{ label: 'a', allowedPaths: ['src/a.ts'] }],
      run: async (_item, sandbox) => {
        await writeFile(join(sandbox, 'src', 'a.ts'), 'export const a = 9;\n');
        await writeFile(join(sandbox, 'src', 'shared.ts'), 'export const shared = 9;\n');
        return { success: true };
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside dependency closure');
    expect(await readFile(join(repo, 'src', 'a.ts'), 'utf8')).toContain('= 1');
    expect(await readFile(join(repo, 'src', 'shared.ts'), 'utf8')).toContain('= 1');
  });

  it('seeds prior-round dirty work into each sandbox without attributing it to the new unit', async () => {
    await writeFile(join(repo, 'src', 'shared.ts'), 'export const shared = 2; // prior round\n');
    let observedBaseline = '';
    const [result] = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 1,
      items: [{ label: 'a', allowedPaths: ['src/a.ts'] }],
      run: async (_item, sandbox) => {
        observedBaseline = await readFile(join(sandbox, 'src', 'shared.ts'), 'utf8');
        await writeFile(join(sandbox, 'src', 'a.ts'), 'export const a = 3;\n');
        return { success: true };
      },
    });
    expect(observedBaseline).toContain('prior round');
    expect(result.filesChanged).toEqual(['src/a.ts']);
    expect(await readFile(join(repo, 'src', 'shared.ts'), 'utf8')).toContain('prior round');
  });

  it('fails all overlapping candidates instead of applying timing-dependent edits', async () => {
    const results = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 2,
      items: [
        { label: 'left', allowedPaths: ['src/shared.ts'] },
        { label: 'right', allowedPaths: ['src/shared.ts'] },
      ],
      run: async (item, sandbox) => {
        await writeFile(join(sandbox, 'src', 'shared.ts'), `export const shared = '${item.label}';\n`);
        return { success: true };
      },
    });
    expect(results.every((result) => !result.success)).toBe(true);
    expect(results.every((result) => result.error?.includes('fix-unit conflict'))).toBe(true);
    expect(await readFile(join(repo, 'src', 'shared.ts'), 'utf8')).toContain('= 1');
  });

  it.each(['../escape.ts', 'src/../../escape.ts', '/tmp/escape.ts'])(
    'rejects an unsafe validated promotion path before mutating the repository: %s',
    async (unsafePath) => {
      await expect(promoteValidatedFiles(repo, repo, [unsafePath])).rejects.toThrow('unsafe sandbox path');
      expect(await readFile(join(repo, 'src', 'a.ts'), 'utf8')).toContain('= 1');
    },
  );

  it('promotes a newline-containing Git filename through NUL-delimited change parsing', async () => {
    const path = 'src/line\nbreak.ts';
    const [result] = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 1,
      items: [{ label: 'newline', allowedPaths: [path] }],
      run: async (_item, sandbox) => {
        await writeFile(join(sandbox, path), 'export const newline = true;\n');
        return { success: true };
      },
    });
    expect(result.success).toBe(true);
    expect(await readFile(join(repo, path), 'utf8')).toContain('true');
  });
});
