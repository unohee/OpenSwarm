// ============================================
// OpenSwarm - repoMetadata tests
// ============================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRepoMetadata, saveRepoMetadata, REPO_METADATA_FILENAME, RepoMetadataError } from './repoMetadata.js';

describe('loadRepoMetadata', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openswarm-meta-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when openswarm.json does not exist', async () => {
    await expect(loadRepoMetadata(dir)).resolves.toBeNull();
  });

  it('parses a valid metadata file', async () => {
    writeFileSync(
      join(dir, REPO_METADATA_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        projectName: 'VEGA',
        linear: {
          teamId: 'ea78d38d-e835-4c58-a17c-5c4eb8d1fb45',
          teamKey: 'RES',
          projectId: 'c49a99e6-e420-463d-9c9a-ca5ee1fa51c2',
          projectName: 'VEGA Agent',
        },
      }),
    );

    const meta = await loadRepoMetadata(dir);
    expect(meta).not.toBeNull();
    expect(meta?.projectName).toBe('VEGA');
    expect(meta?.linear?.projectId).toBe('c49a99e6-e420-463d-9c9a-ca5ee1fa51c2');
    expect(meta?.linear?.teamKey).toBe('RES');
  });

  it('throws RepoMetadataError on invalid JSON', async () => {
    writeFileSync(join(dir, REPO_METADATA_FILENAME), '{ not json');
    await expect(loadRepoMetadata(dir)).rejects.toBeInstanceOf(RepoMetadataError);
  });

  it('throws RepoMetadataError when schemaVersion is wrong', async () => {
    writeFileSync(
      join(dir, REPO_METADATA_FILENAME),
      JSON.stringify({ schemaVersion: 2 }),
    );
    await expect(loadRepoMetadata(dir)).rejects.toBeInstanceOf(RepoMetadataError);
  });

  it('throws RepoMetadataError when linear.projectId is not a UUID', async () => {
    writeFileSync(
      join(dir, REPO_METADATA_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        linear: { projectId: 'not-a-uuid' },
      }),
    );
    await expect(loadRepoMetadata(dir)).rejects.toBeInstanceOf(RepoMetadataError);
  });
});

describe('saveRepoMetadata', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openswarm-meta-save-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a Linear mapping through loadRepoMetadata', async () => {
    const meta = {
      schemaVersion: 1 as const,
      projectName: 'OpenSwarm',
      linear: {
        teamId: '49b7af95-3cac-4a56-adc7-f19d77dfbe9b',
        teamKey: 'INT',
        projectId: '74a9d092-7b3c-4d4d-a998-a2c9a8f08e83',
        projectName: 'OpenSwarm',
      },
    };
    const filePath = await saveRepoMetadata(dir, meta);
    expect(filePath).toBe(join(dir, REPO_METADATA_FILENAME));
    await expect(loadRepoMetadata(dir)).resolves.toEqual(meta);
  });

  it('rejects an invalid mapping (non-uuid projectId) without writing', async () => {
    await expect(
      // projectId is a string at the type level; the uuid check is runtime (zod).
      saveRepoMetadata(dir, { schemaVersion: 1, linear: { projectId: 'not-a-uuid' } }),
    ).rejects.toThrow();
    await expect(loadRepoMetadata(dir)).resolves.toBeNull();
  });
});
