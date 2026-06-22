// ============================================
// OpenSwarm - Per-repo metadata (`openswarm.json`)
// ============================================
//
// Each managed repository may ship an `openswarm.json` at its root.
// The file is the source of truth for repo ↔ external-tracker mapping
// (Linear today, GitHub/etc later) and removes the need for fuzzy
// name matching, which silently breaks on renames or ambiguous names.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const LinearMappingSchema = z.object({
  teamId: z.string().uuid().optional(),
  teamKey: z.string().optional(),
  projectId: z.string().uuid(),
  projectName: z.string().optional(),
});

const GithubMappingSchema = z.object({
  repo: z.string(),
});

const RepoMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  /** Human-friendly project name. Falls back to the directory basename if absent. */
  projectName: z.string().optional(),
  description: z.string().optional(),
  linear: LinearMappingSchema.optional(),
  github: GithubMappingSchema.optional(),
  /** Free-form notes the swarm should keep in mind. */
  notes: z.string().optional(),
});

export type RepoMetadata = z.infer<typeof RepoMetadataSchema>;
export type LinearRepoMapping = z.infer<typeof LinearMappingSchema>;

export const REPO_METADATA_FILENAME = 'openswarm.json';

/**
 * Load `${repoPath}/openswarm.json` if it exists.
 *
 * Returns:
 *  - parsed metadata when the file is present and valid
 *  - `null` when the file does not exist
 *  - throws `RepoMetadataError` when the file exists but is malformed
 *
 * The caller is expected to treat a `null` return as "no explicit mapping" —
 * downstream code may then fall back to fuzzy matching or whatever default it
 * already had.
 */
export async function loadRepoMetadata(repoPath: string): Promise<RepoMetadata | null> {
  const filePath = join(repoPath, REPO_METADATA_FILENAME);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new RepoMetadataError(`Failed to read ${filePath}: ${(err as Error).message}`, filePath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RepoMetadataError(
      `Invalid JSON in ${filePath}: ${(err as Error).message}`,
      filePath,
    );
  }

  const result = RepoMetadataSchema.safeParse(parsed);
  if (!result.success) {
    throw new RepoMetadataError(
      `Invalid schema in ${filePath}: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
      filePath,
    );
  }
  return result.data;
}

/**
 * Write `${repoPath}/openswarm.json`. Validates against the schema first so we
 * never persist a malformed mapping. Returns the written file path.
 * Used by `openswarm init` to record the repo ↔ Linear team/project mapping the
 * user picked, so the daemon resolves this repo without fuzzy name matching.
 */
export async function saveRepoMetadata(repoPath: string, meta: RepoMetadata): Promise<string> {
  const validated = RepoMetadataSchema.parse(meta);
  const filePath = join(repoPath, REPO_METADATA_FILENAME);
  await writeFile(filePath, `${JSON.stringify(validated, null, 2)}\n`, 'utf-8');
  return filePath;
}

export class RepoMetadataError extends Error {
  constructor(message: string, public readonly filePath: string) {
    super(message);
    this.name = 'RepoMetadataError';
  }
}
