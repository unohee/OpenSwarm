import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
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
      scripts: {
        pretest: 'echo trusted-pre',
        test: 'node -e "console.log(require(\'./package.json\').workerMetadata)"',
        posttest: 'echo trusted-post',
      },
    });
    await writeFile(join(repo, 'package.json'), trustedPackageJson, 'utf8');
    git('add', 'package.json');
    git('commit', '-m', 'trusted npm scripts');
    const weakenedPackageJson = JSON.stringify({ workerMetadata: 'current-metadata', scripts: { test: 'true' } });
    await writeFile(join(repo, 'package.json'), weakenedPackageJson, 'utf8');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('npm test --silent')],
      baseRef: 'HEAD',
      trustedPackageJsonByDirectory: { '': trustedPackageJson },
    });

    expect(evidence.rawOutputTail).toContain('trusted-pre');
    expect(evidence.rawOutputTail).toContain('current-metadata');
    expect(evidence.rawOutputTail).toContain('trusted-post');
    expect(await readFile(join(repo, 'package.json'), 'utf8')).toBe(weakenedPackageJson);
  });

  it('pins scripts for a nested command cwd without mutating the source tree', async () => {
    const packageDir = join(repo, 'packages', 'api');
    await mkdir(packageDir, { recursive: true });
    const trusted = JSON.stringify({ scripts: { test: 'echo nested-trusted' } });
    await writeFile(join(packageDir, 'package.json'), trusted);
    git('add', 'packages/api/package.json');
    git('commit', '-m', 'trusted nested package');
    const weakened = JSON.stringify({ workerMetadata: true, scripts: { test: 'true' } });
    await writeFile(join(packageDir, 'package.json'), weakened);

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [{ ...verify('npm test --silent'), cwd: 'packages/api' }],
      baseRef: 'HEAD',
      trustedPackageJsonByDirectory: { 'packages/api': trusted },
    });

    expect(evidence).toMatchObject({ headStatus: 'pass', newFailure: false });
    expect(evidence.rawOutputTail).toContain('nested-trusted');
    expect(await readFile(join(packageDir, 'package.json'), 'utf8')).toBe(weakened);
  });

  it('fails closed when a closer package manifest appears after plan capture', async () => {
    const trustedRoot = JSON.stringify({ scripts: { test: 'echo trusted-root' } });
    await writeFile(join(repo, 'package.json'), trustedRoot);
    git('add', 'package.json');
    git('commit', '-m', 'trusted root package');
    await mkdir(join(repo, 'packages', 'api'), { recursive: true });
    await writeFile(join(repo, 'packages', 'api', 'package.json'), '{"scripts":{"test":"true"}}');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [{ ...verify('npm test --silent'), cwd: 'packages/api' }],
      baseRef: 'HEAD', trustedPackageJsonByDirectory: { '': trustedRoot },
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'skipped', newFailure: true });
    expect(evidence.rawOutputTail).toContain('[security] verify package resolution changed');
  });

  it('fails closed when the captured nearest package manifest is deleted', async () => {
    const packageDir = join(repo, 'packages', 'api');
    await mkdir(packageDir, { recursive: true });
    const trusted = JSON.stringify({ scripts: { test: 'echo trusted' } });
    await writeFile(join(packageDir, 'package.json'), trusted);
    git('add', 'packages/api/package.json');
    git('commit', '-m', 'trusted nested package');
    await unlink(join(packageDir, 'package.json'));

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [{ ...verify('npm test --silent'), cwd: 'packages/api' }],
      baseRef: 'HEAD', trustedPackageJsonByDirectory: { 'packages/api': trusted },
    });
    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'skipped', newFailure: true });
  });

  it('preserves Git metadata inside the isolated head sandbox', async () => {
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('git rev-parse --is-inside-work-tree && git diff --check')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'pass', newFailure: false });
    expect(evidence.rawOutputTail).toContain('true');
  });

  it('does not share the Git index when the source is a linked worktree', async () => {
    const linked = join(root, 'linked');
    git('worktree', 'add', '-q', '-b', 'linked-fixture', linked, 'HEAD');
    const before = execFileSync('git', ['-C', linked, 'status', '--porcelain=v1'], { encoding: 'utf8' });

    const [evidence] = await runVerify({
      projectPath: linked,
      commands: [verify('printf sandbox > README.md; git add README.md')],
      baseRef: 'HEAD',
    });

    expect(evidence.headStatus).toBe('pass');
    expect(execFileSync('git', ['-C', linked, 'status', '--porcelain=v1'], { encoding: 'utf8' })).toBe(before);
    expect(await readFile(join(linked, 'README.md'), 'utf8')).toBe('base\n');
  });

  it('mirrors tracked deletions and renames into the head sandbox', async () => {
    await writeFile(join(repo, 'old-name.txt'), 'tracked\n');
    git('add', 'old-name.txt');
    git('commit', '-m', 'tracked file');
    await unlink(join(repo, 'old-name.txt'));
    await writeFile(join(repo, 'new-name.txt'), 'tracked\n');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('test ! -e old-name.txt && test -e new-name.txt')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'pass', newFailure: false });
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

  it('uses the full output fingerprint when unique failure text precedes the visible tail', async () => {
    await writeFile(join(repo, 'existing-failure'), 'yes\n', 'utf8');
    git('add', 'existing-failure');
    git('commit', '-m', 'pre-existing long failure');
    await writeFile(join(repo, 'new-failure'), 'yes\n', 'utf8');
    const command = "if [ -f new-failure ]; then echo head-only-failure; fi; printf '%09000d' 0; exit 1";

    const [evidence] = await runVerify({ projectPath: repo, commands: [verify(command)], baseRef: 'HEAD' });

    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: true });
    expect(evidence.rawOutputTail).not.toContain('head-only-failure');
  });

  it('does not waive matching failures when dependency inputs changed', async () => {
    await mkdir(join(repo, 'packages', 'app'), { recursive: true });
    await writeFile(join(repo, 'packages', 'app', 'package.json'), '{"dependencies":{"fixture":"1.0.0"}}', 'utf8');
    git('add', 'packages/app/package.json');
    git('commit', '-m', 'base dependency');
    await writeFile(join(repo, 'packages', 'app', 'package.json'), '{"dependencies":{"fixture":"2.0.0"}}', 'utf8');

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [{ ...verify('echo same-failure; exit 1'), cwd: 'packages/app' }],
      baseRef: 'HEAD',
    });

    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'fail', newFailure: true });
  });

  it.each(['Cargo.toml', 'go.mod'])('invalidates baseline failures when %s changes', async (name) => {
    await writeFile(join(repo, name), 'base\n', 'utf8');
    git('add', name);
    git('commit', '-m', `base ${name}`);
    await writeFile(join(repo, name), 'changed\n', 'utf8');

    const [evidence] = await runVerify({
      projectPath: repo, commands: [verify('echo same-failure; exit 1')], baseRef: 'HEAD',
    });
    expect(evidence.newFailure).toBe(true);
  });

  it('detects an untracked nested dependency manifest', async () => {
    await mkdir(join(repo, 'packages', 'new-app'), { recursive: true });
    await writeFile(join(repo, 'packages', 'new-app', 'package.json'), '{"dependencies":{"fixture":"1.0.0"}}');

    const [evidence] = await runVerify({
      projectPath: repo, commands: [verify('echo same-failure; exit 1')], baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ baseStatus: 'fail', headStatus: 'fail', newFailure: true });
  });

  it('classifies command-not-found as infrastructure', async () => {
    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [verify('definitely-not-an-openswarm-command')],
      baseRef: 'HEAD',
    });
    expect(evidence).toMatchObject({ headStatus: 'infra', baseStatus: 'skipped', newFailure: false });
  });

  it('fails closed when a verify cwd symlink escapes the project', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(repo, 'escape'));
    const command = { ...verify('echo escaped'), cwd: 'escape' };

    const [evidence] = await runVerify({ projectPath: repo, commands: [command], baseRef: 'HEAD' });

    expect(evidence).toMatchObject({ headStatus: 'fail', baseStatus: 'skipped', newFailure: true });
    expect(evidence.rawOutputTail).toContain('[security] verify cwd escapes project root');
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
