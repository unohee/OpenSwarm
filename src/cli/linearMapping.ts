// ============================================
// OpenSwarm - Linear repo→project mapping picker
// ============================================
//
// Shared by `openswarm init` (setupLinear) and `openswarm add`: given a Linear
// credential, interactively pick a team + project and persist the repo↔Linear
// mapping into <repo>/openswarm.json. The daemon then resolves this repo by its
// explicit mapping instead of fuzzy name matching (src/support/projectMapper.ts).

import { basename } from 'node:path';
import { select } from '@inquirer/prompts';
import { listTeams, listProjects, type LinearCredential } from '../linear/index.js';
import { saveRepoMetadata, type LinearRepoMapping } from '../support/repoMetadata.js';
import { AuthProfileStore, ensureValidToken } from '../auth/index.js';

/**
 * Resolve a Linear credential for non-interactive use (no auth prompt):
 *  1. linear:default OAuth profile (refreshed via ensureValidToken), then
 *  2. LINEAR_API_KEY env var.
 * Returns null when neither is present — the caller should hint at `auth login`.
 */
export async function resolveLinearCredential(): Promise<LinearCredential | null> {
  try {
    const store = new AuthProfileStore();
    if (store.getProfile('linear:default')) {
      const token = await ensureValidToken(store, 'linear:default');
      return { accessToken: token };
    }
  } catch { // cxt-ignore: error_swallow,exception_hiding — profile unreadable → try API key next
    /* fall through to API key */
  }
  const apiKey = process.env.LINEAR_API_KEY?.trim();
  if (apiKey) return { apiKey };
  return null;
}

export type MappingPickResult =
  | { kind: 'saved'; teamId: string; mapping: LinearRepoMapping }
  | { kind: 'skipped'; teamId?: string } // user skipped the project / team has none
  | { kind: 'no-teams' }; // teams unfetchable or empty

/**
 * Interactive team→project picker that writes <repoPath>/openswarm.json.
 * Logs its own progress. Does NOT prompt for auth — pass a resolved credential.
 * Throws @inquirer's ExitPromptError on Ctrl-C (callers handle it as a skip).
 */
export async function pickAndSaveLinearMapping(
  repoPath: string,
  cred: LinearCredential,
): Promise<MappingPickResult> {
  let teams: Awaited<ReturnType<typeof listTeams>> = [];
  try {
    teams = await listTeams(cred);
  } catch (err) { // cxt-ignore: error_swallow,exception_hiding — surfaced to the user; mapping skipped
    console.log(`   ⚠ Could not fetch Linear teams (${(err as Error).message}).`);
    return { kind: 'no-teams' };
  }
  if (teams.length === 0) return { kind: 'no-teams' };

  const repoName = basename(repoPath);
  const teamId = await select({
    message: `   Linear team for "${repoName}":`,
    choices: teams.map((t) => ({ name: `${t.key} — ${t.name}`, value: t.id })),
  });

  let projects: Awaited<ReturnType<typeof listProjects>> = [];
  try {
    projects = await listProjects(teamId, cred);
  } catch (err) { // cxt-ignore: error_swallow,exception_hiding — surfaced to the user; mapping skipped
    console.log(`   ⚠ Could not fetch projects (${(err as Error).message}).`);
    return { kind: 'skipped', teamId };
  }
  if (projects.length === 0) {
    console.log('   No projects in that team — skipping repo mapping.');
    return { kind: 'skipped', teamId };
  }

  const projectId = await select({
    message: `   Linear project for "${repoName}":`,
    choices: [
      { name: '(skip — no repo mapping)', value: '' },
      ...projects.map((p) => ({ name: p.name, value: p.id })),
    ],
  });
  if (!projectId) return { kind: 'skipped', teamId };

  const proj = projects.find((p) => p.id === projectId);
  const team = teams.find((t) => t.id === teamId);
  const mapping: LinearRepoMapping = {
    teamId,
    teamKey: team?.key,
    projectId,
    projectName: proj?.name,
  };
  const filePath = await saveRepoMetadata(repoPath, {
    schemaVersion: 1,
    projectName: proj?.name,
    linear: mapping,
  });
  console.log(`   Wrote ${filePath} → ${team?.key ?? '?'}/${proj?.name ?? projectId}`);
  return { kind: 'saved', teamId, mapping };
}
