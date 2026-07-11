import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureVerifyInputFingerprint } from './deterministicTester.js';

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('deterministic verification trust inputs', () => {
  it('detects package script and explicit manifest mutation', async () => {
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-trust-'));
    await writeFile(join(root, 'package.json'), '{"scripts":{"test":"vitest"}}');
    const initial = await captureVerifyInputFingerprint(root);
    await writeFile(join(root, 'package.json'), '{"scripts":{"test":"true"}}');
    expect(await captureVerifyInputFingerprint(root)).not.toBe(initial);

    await mkdir(join(root, '.openswarm'));
    await writeFile(join(root, '.openswarm', 'verify.yaml'), 'version: 1\ncommands: []\n');
    expect(await captureVerifyInputFingerprint(root)).not.toBe(initial);
  });
});
