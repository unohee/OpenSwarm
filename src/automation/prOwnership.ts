// ============================================
// OpenSwarm - PR Ownership Tracker
// Tracks which PRs were created by the bot
// Persists to ~/.openswarm/pr-ownership.json

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { atomicWriteFile } from '../support/atomicFile.js';
import { withFileLock } from '../support/fileLock.js';

// Types

export interface OwnedPR {
  repo: string;
  prNumber: number;
  branch: string;
  createdAt: string;
  issueIdentifier?: string;
}

interface OwnershipState {
  prs: OwnedPR[];
  updatedAt: string;
}

const OwnedPRSchema = z.object({
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  branch: z.string().min(1),
  createdAt: z.string().datetime(),
  issueIdentifier: z.string().min(1).optional(),
});
const OwnershipStateSchema = z.object({
  prs: z.array(OwnedPRSchema),
  updatedAt: z.string().min(1),
});

// Constants

const OWNERSHIP_PATH = resolve(homedir(), '.openswarm', 'pr-ownership.json');
const OWNERSHIP_LOCK_PATH = `${OWNERSHIP_PATH}.lock`;

// State Management

async function loadState(): Promise<OwnershipState> {
  try {
    const data = await readFile(OWNERSHIP_PATH, 'utf-8');
    return OwnershipStateSchema.parse(JSON.parse(data));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && !String((error as Error).message).startsWith('ENOENT')) {
      throw new Error(`PR ownership state is invalid at ${OWNERSHIP_PATH}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { prs: [], updatedAt: new Date().toISOString() };
  }
}

async function saveState(state: OwnershipState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await atomicWriteFile(OWNERSHIP_PATH, JSON.stringify(state, null, 2), 0o600);
}

// Public API

/** Register a PR as owned by the bot */
export async function registerOwnedPR(pr: OwnedPR): Promise<void> {
  await withFileLock(OWNERSHIP_LOCK_PATH, async () => {
    const state = await loadState();
    const exists = state.prs.some(
      (p) => p.repo === pr.repo && p.prNumber === pr.prNumber
    );
    if (!exists) {
      state.prs.push(pr);
      await saveState(state);
      console.log(`[PROwnership] Registered: ${pr.repo}#${pr.prNumber} (${pr.branch})`);
    }
  });
}

/** Check if a PR is owned by the bot */
export async function isOwnedPR(repo: string, prNumber: number): Promise<boolean> {
  const state = await loadState();
  return state.prs.some((p) => p.repo === repo && p.prNumber === prNumber);
}

/** Remove a PR from ownership (after merge/close) */
export async function removeOwnedPR(repo: string, prNumber: number): Promise<void> {
  await withFileLock(OWNERSHIP_LOCK_PATH, async () => {
    const state = await loadState();
    const before = state.prs.length;
    state.prs = state.prs.filter(
      (p) => !(p.repo === repo && p.prNumber === prNumber)
    );
    if (state.prs.length < before) {
      await saveState(state);
      console.log(`[PROwnership] Removed: ${repo}#${prNumber}`);
    }
  });
}

/** Get all owned PRs for a repo */
export async function getOwnedPRsForRepo(repo: string): Promise<OwnedPR[]> {
  const state = await loadState();
  return state.prs.filter((p) => p.repo === repo);
}

/** Get all owned PRs */
export async function getAllOwnedPRs(): Promise<OwnedPR[]> {
  const state = await loadState();
  return state.prs;
}
