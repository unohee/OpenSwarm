// ============================================
// OpenSwarm - projectMapper explicit mapping tests
// ============================================
//
// Covers the openswarm.json explicit-mapping path that we added on top of
// the existing fuzzy matcher. We do not exercise the fuzzy path here — it is
// load-bearing legacy and lives untested for now.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mapLinearProject, scanLocalProjects, clearMappingCache } from './projectMapper.js';
import { REPO_METADATA_FILENAME } from './repoMetadata.js';

const LINEAR_PROJECT_ID = 'c49a99e6-e420-463d-9c9a-ca5ee1fa51c2';

function makeRepo(parent: string, name: string, metadata?: unknown): string {
  const p = join(parent, name);
  mkdirSync(p, { recursive: true });
  // analyzeProject() requires .git OR package.json OR pyproject.toml
  mkdirSync(join(p, '.git'), { recursive: true });
  if (metadata !== undefined) {
    writeFileSync(join(p, REPO_METADATA_FILENAME), JSON.stringify(metadata, null, 2));
  }
  return p;
}

describe('mapLinearProject — explicit openswarm.json mapping', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'openswarm-mapper-'));
    clearMappingCache();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    clearMappingCache();
  });

  it('picks the repo whose openswarm.json names the Linear projectId', async () => {
    makeRepo(base, 'random-repo');
    const expected = makeRepo(base, 'totally-unrelated-name', {
      schemaVersion: 1,
      linear: { projectId: LINEAR_PROJECT_ID },
    });

    const result = await mapLinearProject(
      LINEAR_PROJECT_ID,
      'Some Linear Project',
      [base],
    );

    expect(result).toBe(expected);
  });

  it('falls back to fuzzy match when no metadata file matches', async () => {
    // Create a repo whose folder name is close to the Linear project name.
    const fuzzy = makeRepo(base, 'my-special-thing');

    const result = await mapLinearProject(
      LINEAR_PROJECT_ID,
      'my-special-thing',
      [base],
    );

    // Fuzzy match should at least return the directory with the matching name.
    expect(result).toBe(fuzzy);
  });

  it('returns null when neither explicit nor fuzzy match works', async () => {
    makeRepo(base, 'nothing-alike-xyz');
    const result = await mapLinearProject(
      LINEAR_PROJECT_ID,
      'Project That Does Not Exist Anywhere',
      [base],
    );
    expect(result).toBeNull();
  });

  it('keys local project scan cache by basePaths', async () => {
    const otherBase = mkdtempSync(join(tmpdir(), 'openswarm-mapper-other-'));
    try {
      const first = makeRepo(base, 'first-repo');
      const second = makeRepo(otherBase, 'second-repo');

      expect((await scanLocalProjects([base])).map((p) => p.path)).toContain(first);
      expect((await scanLocalProjects([otherBase])).map((p) => p.path)).toContain(second);
      expect((await scanLocalProjects([otherBase])).map((p) => p.path)).not.toContain(first);
    } finally {
      rmSync(otherBase, { recursive: true, force: true });
    }
  });

  it('keys Linear mapping cache by basePaths', async () => {
    const otherBase = mkdtempSync(join(tmpdir(), 'openswarm-mapper-other-'));
    try {
      const first = makeRepo(base, 'shared-name', {
        schemaVersion: 1,
        linear: { projectId: LINEAR_PROJECT_ID },
      });
      const second = makeRepo(otherBase, 'shared-name', {
        schemaVersion: 1,
        linear: { projectId: LINEAR_PROJECT_ID },
      });

      await expect(mapLinearProject(LINEAR_PROJECT_ID, 'shared-name', [base])).resolves.toBe(first);
      await expect(mapLinearProject(LINEAR_PROJECT_ID, 'shared-name', [otherBase])).resolves.toBe(second);
    } finally {
      rmSync(otherBase, { recursive: true, force: true });
    }
  });
});
