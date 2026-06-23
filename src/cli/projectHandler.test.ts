import { describe, it, expect } from 'vitest';
import { addProject, removeProject, loadRepos, emptyReposConfig } from './projectHandler.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('projectHandler registry helpers', () => {
  it('addProject registers to enabled + pinned and lifts the denylist', () => {
    const start = { ...emptyReposConfig(), removedConfigPaths: ['/a/repo'] };
    const out = addProject(start, '/a/repo');
    expect(out.enabled).toContain('/a/repo');
    expect(out.pinned).toContain('/a/repo');
    expect(out.removedConfigPaths).not.toContain('/a/repo'); // denylist lifted
  });

  it('addProject is idempotent (no duplicates)', () => {
    let cfg = emptyReposConfig();
    cfg = addProject(cfg, '/a/repo');
    cfg = addProject(cfg, '/a/repo');
    expect(cfg.enabled.filter((p) => p === '/a/repo')).toHaveLength(1);
    expect(cfg.pinned.filter((p) => p === '/a/repo')).toHaveLength(1);
  });

  it('removeProject drops from enabled/pinned and adds to the denylist', () => {
    const cfg = addProject(emptyReposConfig(), '/a/repo');
    const out = removeProject(cfg, '/a/repo');
    expect(out.enabled).not.toContain('/a/repo');
    expect(out.pinned).not.toContain('/a/repo');
    expect(out.removedConfigPaths).toContain('/a/repo'); // denylisted
  });

  it('loadRepos returns an empty config for a missing file', () => {
    expect(loadRepos('/nonexistent/osw-repos.json')).toEqual(emptyReposConfig());
  });

  it('loadRepos round-trips a written config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'osw-proj-'));
    const file = join(dir, 'repos.json');
    writeFileSync(file, JSON.stringify(addProject(emptyReposConfig(), '/x/y')));
    expect(loadRepos(file).enabled).toContain('/x/y');
  });
});
