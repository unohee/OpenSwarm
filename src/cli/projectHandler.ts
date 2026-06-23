// ============================================
// OpenSwarm - `openswarm project` CLI
// ============================================
//
// Manage the work-repo registry the daemon reads at startup
// (~/.claude/openswarm-repos.json — the same file the web dashboard writes).
// `setWebRunner` (src/support/web.ts) merges `enabled` into both the runner's
// enabled set AND its allowedProjects, so a repo added here is actually worked.

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandPath } from '../core/config.js';
import { c } from '../support/colors.js';

/** Persisted dashboard/CLI repo registry. Mirrors web.ts ReposConfig. */
export interface ReposConfig {
  pinned: string[];
  enabled: string[];
  basePaths: string[];
  removedConfigPaths: string[];
}

export const REPOS_FILE = join(homedir(), '.claude', 'openswarm-repos.json');

export function emptyReposConfig(): ReposConfig {
  return { pinned: [], enabled: [], basePaths: [], removedConfigPaths: [] };
}

export function loadRepos(file: string = REPOS_FILE): ReposConfig {
  if (!existsSync(file)) return emptyReposConfig();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ReposConfig>;
    return {
      pinned: raw.pinned ?? [],
      enabled: raw.enabled ?? [],
      basePaths: raw.basePaths ?? [],
      removedConfigPaths: raw.removedConfigPaths ?? [],
    };
  } catch {
    return emptyReposConfig();
  }
}

function saveRepos(cfg: ReposConfig, file: string = REPOS_FILE): void {
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

const uniq = (a: string[]): string[] => [...new Set(a)];

/** Pure: register a repo (pinned + enabled) and lift it from the denylist. */
export function addProject(cfg: ReposConfig, path: string): ReposConfig {
  return {
    ...cfg,
    pinned: uniq([...cfg.pinned, path]),
    enabled: uniq([...cfg.enabled, path]),
    removedConfigPaths: cfg.removedConfigPaths.filter((p) => p !== path),
  };
}

/** Pure: unregister a repo and add it to the denylist (matches the dashboard unpin). */
export function removeProject(cfg: ReposConfig, path: string): ReposConfig {
  return {
    ...cfg,
    pinned: cfg.pinned.filter((p) => p !== path),
    enabled: cfg.enabled.filter((p) => p !== path),
    removedConfigPaths: uniq([...cfg.removedConfigPaths, path]),
  };
}

export function handleProjectAdd(rawPath: string): void {
  const path = expandPath(rawPath, true);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    console.error(c.red(`✗ Not a directory: ${path}`));
    process.exit(1);
  }
  if (!existsSync(join(path, '.git'))) {
    console.error(c.yellow(`⚠ ${path} is not a git repo — workers run in git worktrees and need one.`));
  }
  saveRepos(addProject(loadRepos(), path));
  console.log(c.green(`✓ Added work repo: ${path}`));
  console.log(c.dim('  Restart the daemon (openswarm start) to pick it up.'));
}

export function handleProjectList(): void {
  const cfg = loadRepos();
  console.log(c.bold('Work repos (enabled):'));
  if (cfg.enabled.length === 0) console.log('  (none)');
  for (const p of cfg.enabled) console.log(`  ${c.green('✓')} ${p}${cfg.pinned.includes(p) ? c.dim(' (pinned)') : ''}`);
  if (cfg.removedConfigPaths.length > 0) {
    console.log(c.dim('\nExcluded (denylist):'));
    for (const p of cfg.removedConfigPaths) console.log(c.dim(`  ✗ ${p}`));
  }
}

export function handleProjectRm(rawPath: string): void {
  const path = expandPath(rawPath, true);
  const cfg = loadRepos();
  if (!cfg.enabled.includes(path) && !cfg.pinned.includes(path)) {
    console.error(c.yellow(`⚠ Not a registered work repo: ${path} (removing anyway / denylisting)`));
  }
  saveRepos(removeProject(cfg, path));
  console.log(c.green(`✓ Removed work repo: ${path}`));
  console.log(c.dim('  Restart the daemon to apply.'));
}
