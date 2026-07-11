import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureVerifyInputFingerprint, runTesterWithVerification } from './deterministicTester.js';

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('deterministic verification trust inputs', () => {
  it('allows ordinary package script mutation because discovered bodies are pinned separately', async () => {
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-trust-'));
    await writeFile(join(root, 'package.json'), '{"scripts":{"test":"vitest"}}');
    const initial = await captureVerifyInputFingerprint(root);
    await writeFile(join(root, 'package.json'), '{"scripts":{"test":"true"}}');
    expect(await captureVerifyInputFingerprint(root)).toBe(initial);

  });

  it('detects explicit manifest mutation independently', async () => {
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-trust-'));
    await mkdir(join(root, '.openswarm'));
    const initial = await captureVerifyInputFingerprint(root);
    await writeFile(join(root, '.openswarm', 'verify.yaml'), 'version: 1\ncommands: []\n');
    expect(await captureVerifyInputFingerprint(root)).not.toBe(initial);
  });

  it('fails closed without invoking fallback when trusted inputs change', async () => {
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-trust-'));
    const trustedInputFingerprint = await captureVerifyInputFingerprint(root);
    await mkdir(join(root, '.openswarm'));
    await writeFile(join(root, '.openswarm', 'verify.yaml'), 'version: 1\ncommands: []\n');
    const fallback = vi.fn();

    await expect(runTesterWithVerification({
      projectPath: root,
      verify: { enabled: true, blockOnNewFailures: true, maxCommands: 4 },
      trustedInputFingerprint,
      fallback,
    })).rejects.toThrow('verification inputs changed after worker execution');
    expect(fallback).not.toHaveBeenCalled();
  });
});
