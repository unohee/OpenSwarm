import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverVerifyCommands } from './discover.js';

const roots: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openswarm-verify-discover-'));
  roots.push(root);
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(root, name), content, 'utf8')));
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('discoverVerifyCommands', () => {
  it('discovers Node typecheck and test scripts', async () => {
    const root = await fixture({ 'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' } }) });
    expect(await discoverVerifyCommands(root)).toEqual([
      { name: 'typecheck', run: 'npm run typecheck', kind: 'typecheck', timeoutMs: 300_000 },
      { name: 'test', run: 'npm run test', kind: 'test', timeoutMs: 300_000 },
    ]);
  });

  it('falls back to tsc and ignores the npm placeholder test', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      'tsconfig.json': '{}',
    });
    expect(await discoverVerifyCommands(root)).toEqual([
      { name: 'typecheck', run: 'npx tsc --noEmit', kind: 'typecheck', timeoutMs: 300_000 },
    ]);
  });

  it.each([
    ['pytest.ini', '[pytest]\n'],
    ['pyproject.toml', '[tool.pytest.ini_options]\naddopts = "-q"\n'],
    ['setup.cfg', '[tool:pytest]\naddopts = -q\n'],
  ])('discovers pytest from %s', async (name, content) => {
    const root = await fixture({ [name]: content });
    expect(await discoverVerifyCommands(root)).toEqual([
      { name: 'pytest', run: 'python -m pytest -x -q', kind: 'test', timeoutMs: 300_000 },
    ]);
  });

  it('discovers Rust tests', async () => {
    const root = await fixture({ 'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\n' });
    expect(await discoverVerifyCommands(root)).toEqual([
      { name: 'cargo test', run: 'cargo test --quiet', kind: 'test', timeoutMs: 300_000 },
    ]);
  });

  it('discovers Go tests', async () => {
    const root = await fixture({ 'go.mod': 'module example.test/demo\n' });
    expect(await discoverVerifyCommands(root)).toEqual([
      { name: 'go test', run: 'go test ./...', kind: 'test', timeoutMs: 300_000 },
    ]);
  });

  it('returns an empty list for an empty repository', async () => {
    expect(await discoverVerifyCommands(await fixture({}))).toEqual([]);
  });

  it('discovers this OpenSwarm checkout without executing commands', async () => {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const commands = await discoverVerifyCommands(repo);
    expect(commands.map((item) => item.run)).toEqual(expect.arrayContaining(['npm run typecheck', 'npm run test']));
  });
});
