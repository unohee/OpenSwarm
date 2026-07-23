import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadVerifyManifest } from './manifest.js';

const roots: string[] = [];

async function projectWithManifest(source?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openswarm-verify-manifest-'));
  roots.push(root);
  if (source !== undefined) {
    await mkdir(join(root, '.openswarm'), { recursive: true });
    await writeFile(join(root, '.openswarm', 'verify.yaml'), source, 'utf8');
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('loadVerifyManifest', () => {
  it('loads a valid manifest and applies the default timeout', async () => {
    const project = await projectWithManifest(`
version: 1
commands:
  - name: typecheck
    run: npm run typecheck
    kind: typecheck
`);

    await expect(loadVerifyManifest(project)).resolves.toEqual({
      manifest: {
        version: 1,
        commands: [{ name: 'typecheck', run: 'npm run typecheck', kind: 'typecheck', timeoutMs: 300_000 }],
      },
    });
  });

  it('preserves an explicit timeout and relative cwd', async () => {
    const project = await projectWithManifest(`
version: 1
commands:
  - name: unit tests
    run: pytest -q
    kind: test
    timeoutMs: 600000
    cwd: backend
`);
    const result = await loadVerifyManifest(project);
    expect(result.manifest?.commands[0]).toMatchObject({ timeoutMs: 600_000, cwd: 'backend' });
  });

  it('treats a missing manifest as a normal absence', async () => {
    const project = await projectWithManifest();
    await expect(loadVerifyManifest(project)).resolves.toEqual({ manifest: null });
  });

  it('reports malformed YAML instead of swallowing it', async () => {
    const project = await projectWithManifest('version: 1\ncommands: [\n');
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('Failed to parse .openswarm/verify.yaml');
  });

  it('rejects an oversized manifest before YAML parsing', async () => {
    const project = await projectWithManifest(`version: 1\ncommands:\n${' '.repeat(70 * 1024)}`);
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('manifest exceeds 65536 bytes');
  });

  it('rejects a symlinked manifest instead of following special or external files', async () => {
    const project = await projectWithManifest();
    const outside = join(project, 'outside.yaml');
    await writeFile(outside, 'version: 1\ncommands: []\n');
    await mkdir(join(project, '.openswarm'), { recursive: true });
    await symlink(outside, join(project, '.openswarm', 'verify.yaml'));
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('Failed to read');
  });

  it('reports an unsupported command kind', async () => {
    const project = await projectWithManifest('version: 1\ncommands:\n  - name: deploy\n    run: ./deploy\n    kind: deploy\n');
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('commands.0.kind');
  });

  it('rejects an empty commands list', async () => {
    const project = await projectWithManifest('version: 1\ncommands: []\n');
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('At least one verify command is required');
  });

  it('rejects a timeout above 15 minutes', async () => {
    const project = await projectWithManifest('version: 1\ncommands:\n  - name: build\n    run: npm run build\n    kind: build\n    timeoutMs: 900001\n');
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('commands.0.timeoutMs');
  });

  it('rejects multiline shell commands', async () => {
    const project = await projectWithManifest('version: 1\ncommands:\n  - name: test\n    run: |\n      npm test\n      npm run lint\n    kind: test\n');
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('Command must be a single line');
  });

  it('rejects NUL bytes before passing a command to spawn', async () => {
    const project = await projectWithManifest('version: 1\ncommands:\n  - name: test\n    run: "npm test\\0"\n    kind: test\n');
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('must not contain NUL bytes');
  });

  it('rejects a cwd that escapes the repository', async () => {
    const project = await projectWithManifest('version: 1\ncommands:\n  - name: test\n    run: npm test\n    kind: test\n    cwd: ../outside\n');
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('cwd must stay within the repository');
  });

  it('rejects NUL bytes in cwd before filesystem calls', async () => {
    const project = await projectWithManifest('version: 1\ncommands:\n  - name: test\n    run: npm test\n    kind: test\n    cwd: "subdir\\0"\n');
    const result = await loadVerifyManifest(project);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('cwd must not contain NUL bytes');
  });
});
