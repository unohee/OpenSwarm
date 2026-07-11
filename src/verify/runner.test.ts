import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VerifyCommand } from './manifest.js';
import { runVerify } from './runner.js';

let root: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function verify(run: string, timeoutMs = 2_000): VerifyCommand {
  return { name: 'fixture', run, kind: 'test', timeoutMs };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openswarm-verify-runner-'));
  repo = join(root, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await writeFile(join(repo, 'README.md'), 'base\n', 'utf8');
  git('add', '-A');
  git('commit', '-m', 'base');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('runVerify', () => {
  it('skips the base worktree when head passes', async () => {
    const [evidence] = await runVerify({ projectPath: repo, commands: [verify('printf head-pass')], baseRef: 'HEAD' });
    expect(evidence).toMatchObject({ headStatus: 'pass', baseStatus: 'skipped', newFailure: false });
    expect(evidence.rawOutputTail).toContain('head-pass');
    expect(git('worktree', 'list', '--porcelain')).not.toContain('openswarm-verify-base-');
  });

  it('marks a head failure over a passing base as new', async () => {
    await writeFile(join(repo, 'broken'), 'yes\n', 'utf8');
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('if [ -f broken ]; then echo broken >&2; exit 1; fi')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'pass', newFailure: true });
    expect(evidence.rawOutputTail).toContain('[head]\nbroken');
    expect(git('worktree', 'list', '--porcelain')).not.toContain('openswarm-verify-base-');
  });

  it('reuses head-local executable dependencies in the detached base worktree', async () => {
    const bin = join(repo, 'node_modules', '.bin');
    await mkdir(bin, { recursive: true });
    const executable = join(bin, 'verify-fixture');
    await writeFile(executable, '#!/bin/sh\nif [ -f broken ]; then exit 1; fi\n', 'utf8');
    await chmod(executable, 0o755);
    await writeFile(join(repo, 'broken'), 'yes\n', 'utf8');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('PATH="$PWD/node_modules/.bin:$PATH" verify-fixture')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'pass', newFailure: true });
  });

  it('runs npm package scripts against head-installed node_modules at base', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      scripts: { test: 'verify-fixture' },
    }), 'utf8');
    git('add', 'package.json');
    git('commit', '-m', 'base package script');
    const bin = join(repo, 'node_modules', '.bin');
    await mkdir(bin, { recursive: true });
    const executable = join(bin, 'verify-fixture');
    await writeFile(executable, '#!/bin/sh\nif [ -f broken ]; then exit 1; fi\n', 'utf8');
    await chmod(executable, 0o755);
    await writeFile(join(repo, 'broken'), 'yes\n', 'utf8');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('npm test --silent')],
      baseRef: 'HEAD',
    });

    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'pass', newFailure: true });
  });

  it('preserves trusted npm lifecycle scripts and restores the worker package', async () => {
    const trustedPackageJson = JSON.stringify({
      scripts: { pretest: 'echo trusted-pre', test: 'echo trusted-test', posttest: 'echo trusted-post' },
    });
    await writeFile(join(repo, 'package.json'), trustedPackageJson, 'utf8');
    git('add', 'package.json');
    git('commit', '-m', 'trusted npm scripts');
    const weakenedPackageJson = JSON.stringify({ scripts: { test: 'true' } });
    await writeFile(join(repo, 'package.json'), weakenedPackageJson, 'utf8');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('  npm run-script test --silent')],
      baseRef: 'HEAD',
      trustedPackageJson,
    });

    expect(evidence.rawOutputTail).toContain('trusted-pre');
    expect(evidence.rawOutputTail).toContain('trusted-test');
    expect(evidence.rawOutputTail).toContain('trusted-post');
    expect(await readFile(join(repo, 'package.json'), 'utf8')).toBe(weakenedPackageJson);
  });

  it('keeps a failure that also exists at base non-blocking', async () => {
    await writeFile(join(repo, 'broken'), 'yes\n', 'utf8');
    git('add', 'broken');
    git('commit', '-m', 'pre-existing failure');
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('test ! -f broken')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: false });
  });

  it('marks an additional head failure as new when base already fails', async () => {
    await writeFile(join(repo, 'existing-failure'), 'yes\n', 'utf8');
    git('add', 'existing-failure');
    git('commit', '-m', 'pre-existing failure');
    await writeFile(join(repo, 'new-failure'), 'yes\n', 'utf8');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('for file in existing-failure new-failure; do if [ -f "$file" ]; then echo "$file" >&2; failed=1; fi; done; test -z "$failed"')],
      baseRef: 'HEAD',
    });

    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: true });
    expect(evidence.rawOutputTail).toContain('[base]\nexisting-failure');
    expect(evidence.rawOutputTail).toContain('[head]\nexisting-failure\nnew-failure');
  });

  it('classifies command-not-found as infrastructure', async () => {
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('definitely-not-an-openswarm-command')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'infra', baseStatus: 'skipped', newFailure: false });
  });

  it('classifies a timeout as infrastructure', async () => {
    const started = Date.now();
    const [evidence] = await runVerify({ projectPath: repo, commands: [verify('sleep 1', 20)], baseRef: 'HEAD' });
    expect(evidence).toMatchObject({ headStatus: 'infra', baseStatus: 'skipped', newFailure: false });
    expect(evidence.rawOutputTail).toContain('timeout after 20ms');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('caps combined stdout and stderr to the last 8KB', async () => {
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify("printf '%09000d' 0; printf tail-marker >&2")],
      baseRef: 'HEAD',
    });
    expect(Buffer.byteLength(evidence.rawOutputTail)).toBeLessThanOrEqual(8 * 1024);
    expect(evidence.rawOutputTail).toContain('tail-marker');
  });
});
