// ============================================
// OpenSwarm - Adaptive worker fan-out
// ============================================
//
// Runs candidate workers in isolated temporary git clones and promotes only the
// selected winner's diff back into the real project path.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { WorkerFanoutCandidateConfig, PipelineGuardsConfig } from '../core/types.js';
import { runPool } from '../support/concurrencyPool.js';
import { loadRepoMetadata } from '../support/repoMetadata.js';
import { resolveSharedPaths } from '../support/worktreeManager.js';
import type { WorkerResult } from './agentPair.js';
import { runWorker, type WorkerOptions } from './worker.js';
import { runGuards, type GuardsRunResult } from './pipelineGuards.js';

const exec = promisify(execFile);

export interface WorkerFanoutCandidateRun {
  id: string;
  projectPath: string;
  result: WorkerResult;
  filesChanged: string[];
  guards?: GuardsRunResult;
  durationMs: number;
  score: number;
  eligible: boolean;
  error?: string;
}

export interface WorkerFanoutRunResult {
  winner?: WorkerFanoutCandidateRun;
  candidates: WorkerFanoutCandidateRun[];
  fallbackReason?: string;
}

export interface RunWorkerFanoutOptions {
  projectPath: string;
  baseWorkerOptions: WorkerOptions;
  candidates: WorkerFanoutCandidateConfig[];
  concurrency: number;
  keepSandboxes?: boolean;
  /**
   * Shared deps/data handling:
   * - undefined: copy shared paths into each sandbox (verification works, no loser write leak)
   * - true: symlink shared paths (faster, but writes hit the original shared path)
   * - false: do not provide shared paths
   */
  linkSharedPaths?: boolean;
  guards?: Partial<PipelineGuardsConfig>;
  onLog?: (line: string) => void;
}

function safeCandidateId(id: string, index: number): string {
  const safe = id.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return safe || `candidate-${index + 1}`;
}

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    maxBuffer: 20 * 1024 * 1024,
  } as Parameters<typeof exec>[2] & { input?: string });
  return String(stdout);
}

async function isGitWorktreeClean(projectPath: string): Promise<boolean> {
  try {
    const status = await git(projectPath, ['status', '--porcelain']);
    return status.trim().length === 0;
  } catch {
    return false;
  }
}

async function cloneSandbox(
  projectPath: string,
  root: string,
  id: string,
  sharedPathMode: 'copy' | 'link' | 'off',
): Promise<string> {
  const sandbox = join(root, id);
  await git(projectPath, ['clone', '--quiet', '--no-hardlinks', '--', projectPath, sandbox]);
  if (sharedPathMode === 'link') await linkSharedPaths(projectPath, sandbox);
  if (sharedPathMode === 'copy') await copySharedPaths(projectPath, sandbox);
  return sandbox;
}

async function linkSharedPaths(projectPath: string, sandboxPath: string): Promise<void> {
  let metadata = null;
  try {
    metadata = await loadRepoMetadata(projectPath);
  } catch {
    metadata = null;
  }

  for (const rel of resolveSharedPaths(projectPath, metadata)) {
    const target = resolve(projectPath, rel);
    const linkPath = resolve(sandboxPath, rel);
    if (existsSync(linkPath)) continue;
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(target, linkPath);
  }
}

async function copySharedPaths(projectPath: string, sandboxPath: string): Promise<void> {
  let metadata = null;
  try {
    metadata = await loadRepoMetadata(projectPath);
  } catch {
    metadata = null;
  }

  for (const rel of resolveSharedPaths(projectPath, metadata)) {
    const source = resolve(projectPath, rel);
    const target = resolve(sandboxPath, rel);
    if (existsSync(target)) continue;
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, {
      recursive: true,
      force: false,
      errorOnExist: false,
      verbatimSymlinks: true,
    });
  }
}

function sharedPathModeFor(linkSharedPaths: boolean | undefined): 'copy' | 'link' | 'off' {
  if (linkSharedPaths === true) return 'link';
  if (linkSharedPaths === false) return 'off';
  return 'copy';
}

async function changedFiles(projectPath: string): Promise<string[]> {
  const out = await git(projectPath, ['status', '--porcelain']).catch(() => '');
  return out
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const file = line.slice(3);
      return file.includes(' -> ') ? file.split(' -> ').pop() ?? file : file;
    })
    .filter(Boolean);
}

async function diffBinary(projectPath: string): Promise<string> {
  await git(projectPath, ['add', '-A']);
  return git(projectPath, ['diff', '--cached', '--binary', 'HEAD']);
}

async function applyDiff(projectPath: string, patchRoot: string, diff: string): Promise<void> {
  const patchPath = join(patchRoot, 'winner.patch');
  await writeFile(patchPath, diff, 'utf8');
  await git(projectPath, ['apply', '--3way', '--whitespace=nowarn', patchPath]);
}

function scoreCandidate(input: {
  result: WorkerResult;
  filesChanged: string[];
  guards?: GuardsRunResult;
  durationMs: number;
  error?: string;
}): { score: number; eligible: boolean } {
  const blockingIssues = input.guards?.results.filter((r) => !r.passed && r.blocking).flatMap((r) => r.issues) ?? [];
  const hasDiff = input.filesChanged.length > 0;
  const guardsPass = blockingIssues.length === 0;
  const eligible = input.result.success && hasDiff && guardsPass && !input.error;

  let score = 0;
  if (input.result.success) score += 100;
  if (hasDiff) score += 25;
  if (guardsPass) score += 25;
  if (typeof input.result.confidencePercent === 'number') score += Math.max(0, Math.min(100, input.result.confidencePercent)) / 10;
  score -= Math.min(input.filesChanged.length, 20);
  score -= Math.min(Math.round(input.durationMs / 30_000), 20);
  if (input.error) score -= 100;
  if (blockingIssues.length > 0) score -= 50 + blockingIssues.length * 5;

  return { score, eligible };
}

async function runCandidate(
  options: RunWorkerFanoutOptions,
  candidate: WorkerFanoutCandidateConfig,
  index: number,
  root: string,
): Promise<WorkerFanoutCandidateRun> {
  const id = safeCandidateId(candidate.id, index);
  const started = Date.now();
  let sandbox = '';

  try {
    sandbox = await cloneSandbox(options.projectPath, root, id, sharedPathModeFor(options.linkSharedPaths));
    const result = await runWorker({
      ...options.baseWorkerOptions,
      projectPath: sandbox,
      model: candidate.model ?? options.baseWorkerOptions.model,
      adapterName: candidate.adapter ?? options.baseWorkerOptions.adapterName,
      reasoningEffort: candidate.reasoningEffort ?? options.baseWorkerOptions.reasoningEffort,
      maxTurns: candidate.maxTurns ?? options.baseWorkerOptions.maxTurns,
      nudgeMaxOnNoEdit: candidate.nudgeMaxOnNoEdit ?? options.baseWorkerOptions.nudgeMaxOnNoEdit,
      webTools: candidate.webTools ?? options.baseWorkerOptions.webTools,
      memoryTools: candidate.memoryTools ?? options.baseWorkerOptions.memoryTools,
      processContext: options.baseWorkerOptions.processContext
        ? { ...options.baseWorkerOptions.processContext, stage: `worker:${id}` }
        : undefined,
      onLog: (line) => options.onLog?.(`[${id}] ${line}`),
    });
    const files = await changedFiles(sandbox);
    const guards = options.guards && files.length > 0
      ? await runGuards({ ...result, filesChanged: files }, sandbox, options.guards)
      : undefined;
    const scored = scoreCandidate({ result, filesChanged: files, guards, durationMs: Date.now() - started });
    return {
      id,
      projectPath: sandbox,
      result,
      filesChanged: files,
      guards,
      durationMs: Date.now() - started,
      score: scored.score,
      eligible: scored.eligible,
    };
  } catch (err) {
    const result: WorkerResult = {
      success: false,
      summary: `Fan-out candidate ${id} failed`,
      filesChanged: [],
      commands: [],
      output: '',
      error: err instanceof Error ? err.message : String(err),
    };
    const scored = scoreCandidate({ result, filesChanged: [], durationMs: Date.now() - started, error: result.error });
    return {
      id,
      projectPath: sandbox,
      result,
      filesChanged: [],
      durationMs: Date.now() - started,
      score: scored.score,
      eligible: false,
      error: result.error,
    };
  }
}

export async function runWorkerFanout(options: RunWorkerFanoutOptions): Promise<WorkerFanoutRunResult> {
  if (options.candidates.length < 2) {
    return { candidates: [], fallbackReason: 'fan-out needs at least two candidates' };
  }

  if (!(await isGitWorktreeClean(options.projectPath))) {
    return { candidates: [], fallbackReason: 'project worktree has pre-existing changes' };
  }

  const root = await mkdtemp(join(tmpdir(), 'openswarm-worker-fanout-'));
  try {
    options.onLog?.(`[fanout] launching ${options.candidates.length} candidate worker(s)`);
    const settled = await runPool(
      options.candidates,
      options.concurrency,
      (candidate, index) => runCandidate(options, candidate, index, root),
      (item) => {
        if (item.value) {
          options.onLog?.(`[fanout] ${item.value.id}: score=${item.value.score.toFixed(1)} eligible=${item.value.eligible} files=${item.value.filesChanged.length}`);
        } else if (item.error) {
          options.onLog?.(`[fanout] candidate ${item.index + 1} failed: ${item.error instanceof Error ? item.error.message : String(item.error)}`);
        }
      },
    );

    const candidates = settled
      .map((item) => item.value)
      .filter((item): item is WorkerFanoutCandidateRun => Boolean(item));
    const winner = candidates
      .filter((candidate) => candidate.eligible)
      .sort((a, b) => b.score - a.score)[0];

    if (!winner) {
      return { candidates, fallbackReason: 'no eligible fan-out candidate produced a guarded diff' };
    }

    const diff = await diffBinary(winner.projectPath);
    if (!diff.trim()) {
      return { candidates, fallbackReason: 'selected fan-out candidate had no diff to promote' };
    }

    await applyDiff(options.projectPath, root, diff);
    const promotedFiles = await changedFiles(options.projectPath);
    winner.result = {
      ...winner.result,
      summary: `[fanout:${winner.id}] ${winner.result.summary}`,
      filesChanged: promotedFiles,
    };
    options.onLog?.(`[fanout] promoted ${winner.id}: ${promotedFiles.length} file(s)`);
    return { winner, candidates };
  } finally {
    if (!options.keepSandboxes) {
      await rm(root, { recursive: true, force: true });
    } else {
      options.onLog?.(`[fanout] kept sandboxes at ${root}`);
    }
  }
}
