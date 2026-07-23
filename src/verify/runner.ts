import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, cp, lstat, mkdtemp, readFile, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { isInfraError } from '../adapters/errorClassification.js';
import { copyIsolatedPath } from '../support/isolatedPath.js';
import { loadRepoMetadata } from '../support/repoMetadata.js';
import { resolveSharedPaths } from '../support/worktreeManager.js';
import { atomicWriteFileSync } from '../support/atomicFile.js';
import type { VerifyCommand } from './manifest.js';

const OUTPUT_TAIL_BYTES = 8 * 1024;
const execFileAsync = promisify(execFile);
const DEPENDENCY_INPUTS = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
  'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', 'requirements.txt', 'pyproject.toml',
  'uv.lock', 'poetry.lock',
]);

export interface VerifyEvidence {
  command: VerifyCommand;
  baseStatus: 'pass' | 'fail' | 'infra' | 'skipped';
  headStatus: 'pass' | 'fail' | 'infra';
  newFailure: boolean;
  rawOutputTail: string;
  durationMs: number;
}

export interface RunVerifyOptions {
  projectPath: string;
  commands: VerifyCommand[];
  baseRef: string;
  trustedPackageJsonByDirectory?: Record<string, string>;
}

interface CommandResult {
  status: 'pass' | 'fail' | 'infra';
  output: string;
  outputFingerprint?: string;
  environmentFailure?: boolean;
  baselineEnvironmentChanged?: boolean;
}

async function verificationSharedPaths(projectPath: string, commands: VerifyCommand[]): Promise<string[]> {
  let metadata = null;
  try { metadata = await loadRepoMetadata(projectPath); } catch { metadata = null; }
  const paths = new Set(resolveSharedPaths(projectPath, metadata));
  for (const command of commands) {
    const directory = command.cwd ?? '';
    const nodeModules = join(directory, 'node_modules');
    try {
      await access(join(projectPath, nodeModules));
      paths.add(nodeModules);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return [...paths];
}

function pathCoveredBy(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}${sep}`));
}

function hasSameFailure(base: CommandResult, head: CommandResult): boolean {
  // A shared non-zero exit code is not enough to prove that the failure is
  // pre-existing: HEAD may contain the old failure plus a new regression.
  // Only waive the failure when the observable failure output is identical.
  // Commands with unstable output therefore fail closed and require review.
  return base.outputFingerprint !== undefined && base.outputFingerprint === head.outputFingerprint;
}

function normalizeFailureOutput(output: string, projectRoot: string): string {
  const escapedRoot = projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return output
    .replace(new RegExp(escapedRoot, 'g'), '<PROJECT>')
    .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
    .replace(/(=+ .*? in )\d+(?:\.\d+)?s( =+)/g, '$1<DURATION>$2')
    .replace(/(Ran \d+ tests? in )\d+(?:\.\d+)?s/g, '$1<DURATION>')
    .replace(/(finished in )\d+(?:\.\d+)?s/gi, '$1<DURATION>');
}

function isEnvironmentFailure(output: string): boolean {
  return [
    /ModuleNotFoundError:\s*No module named\b/i,
    /ImportError:\s*No module named\b/i,
    /Cannot find module ['"]/i,
    /could not find [`']?Cargo\.toml/i,
    /failed to (?:load|read) manifest for workspace member/i,
    /Cargo\.toml.*(?:No such file or directory|os error 2)/i,
  ].some((pattern) => pattern.test(output));
}

function appendTail(current: Buffer, chunk: Buffer): Buffer {
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= OUTPUT_TAIL_BYTES ? combined : combined.subarray(combined.length - OUTPUT_TAIL_BYTES);
}

async function terminateVerificationProcesses(processGroupId: number | undefined, marker: string): Promise<void> {
  if (processGroupId && process.platform !== 'win32') {
    try { process.kill(-processGroupId, 'SIGKILL'); } catch { /* already exited */ }
  }
  if (process.platform === 'win32') return;
  // A child may have created a new session to escape the original process
  // group. The per-run marker survives ordinary forks, so reap any such
  // descendants before deleting their sandbox.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let stdout = '';
    try {
      ({ stdout } = await execFileAsync('ps', ['eww', '-axo', 'pid=,command='], { maxBuffer: 4 * 1024 * 1024 }));
    } catch {
      return;
    }
    const pids = stdout.split('\n')
      .filter((line) => line.includes(marker))
      .map((line) => Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? '', 10))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
    if (pids.length === 0) return;
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* raced with exit */ }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

async function runCommand(command: VerifyCommand, root: string, env: NodeJS.ProcessEnv = process.env): Promise<CommandResult> {
  const candidate = command.cwd ? resolve(root, command.cwd) : root;
  let cwd: string;
  try {
    const [realRoot, realCwd] = await Promise.all([realpath(root), realpath(candidate)]);
    if (realCwd !== realRoot && !realCwd.startsWith(`${realRoot}${sep}`)) {
      return { status: 'fail', output: `[security] verify cwd escapes project root: ${command.cwd ?? '.'}` };
    }
    cwd = realCwd;
  } catch (error) {
    return { status: 'infra', output: error instanceof Error ? error.message : String(error) };
  }
  const isolatedHome = join(dirname(root), 'home');
  const processMarker = `openswarm-verify-${randomUUID()}`;
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: env.PATH,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_CACHE_HOME: join(isolatedHome, '.cache'),
    XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
    OPENSWARM_VERIFY_PROCESS_MARKER: processMarker,
  };
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'CI', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT']) {
    if (env[key] !== undefined) safeEnv[key] = env[key];
  }
  const shell = process.env.SHELL || '/bin/sh';
  return await new Promise((resolveResult) => {
    let output: Buffer = Buffer.alloc(0);
    const outputHash = createHash('sha256');
    let settled = false;
    let timedOut = false;
    const detached = process.platform !== 'win32';
    const child = spawn(shell, ['-lc', command.run], {
      cwd,
      env: safeEnv,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record = (chunk: Buffer) => {
      outputHash.update(normalizeFailureOutput(chunk.toString('utf8'), cwd));
      output = appendTail(output, chunk);
    };
    child.stdout.on('data', record);
    child.stderr.on('data', record);

    const finish = (status: CommandResult['status'], extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (extra) {
        outputHash.update(normalizeFailureOutput(extra, cwd));
        output = appendTail(output, Buffer.from(extra));
      }
      const outputText = output.toString('utf8');
      resolveResult({
        status,
        output: outputText,
        outputFingerprint: outputHash.digest('hex'),
        environmentFailure: status === 'fail' && isEnvironmentFailure(outputText),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        child.kill('SIGKILL');
      }
    }, command.timeoutMs ?? 300_000);

    child.on('error', (error) => {
      const infra = isInfraError(error) || (error as NodeJS.ErrnoException).code !== undefined;
      finish(infra ? 'infra' : 'fail', `\n${error.message}`);
    });
    child.on('close', (code, signal) => {
      void (async () => {
      await terminateVerificationProcesses(child.pid, processMarker);
      if (timedOut) {
        const error = new Error(`timeout after ${command.timeoutMs ?? 300_000}ms`);
        finish(isInfraError(error) ? 'infra' : 'fail', `\n${error.message}`);
      } else if (code === 0) {
        finish('pass');
      } else if (code === 126 || code === 127 || signal) {
        const error = new Error(`spawn command exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`);
        finish(isInfraError(error) ? 'infra' : 'fail', `\n${error.message}`);
      } else {
        finish('fail');
      }
      })();
    });
  });
}

async function runTrustedCommand(
  command: VerifyCommand,
  root: string,
  trustedPackageJsonByDirectory?: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  if (trustedPackageJsonByDirectory === undefined) return await runCommand(command, root, env);
  const projectRoot = await realpath(root);
  const candidate = resolve(projectRoot, command.cwd ?? '.');
  let directory: string;
  try {
    directory = await realpath(candidate);
  } catch (error) {
    return { status: 'infra', output: error instanceof Error ? error.message : String(error) };
  }
  if (directory !== projectRoot && !directory.startsWith(`${projectRoot}${sep}`)) {
    return { status: 'fail', output: `[security] verify package cwd escapes project root: ${command.cwd ?? '.'}` };
  }
  let trustedPackageJson: string | undefined;
  while (directory === projectRoot || directory.startsWith(`${projectRoot}${sep}`)) {
    const key = relative(projectRoot, directory);
    const trusted = trustedPackageJsonByDirectory[key];
    const packagePath = join(directory, 'package.json');
    let actual: string | undefined;
    try {
      const stat = await lstat(packagePath);
      if (stat.isSymbolicLink()) {
        return { status: 'fail', output: `[security] verify package.json is a symlink for cwd: ${command.cwd ?? '.'}` };
      }
      actual = await readFile(packagePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (trusted !== undefined || actual !== undefined) {
      if (trusted === undefined || actual === undefined) {
        return { status: 'fail', output: `[security] verify package resolution changed for cwd: ${command.cwd ?? '.'}` };
      }
      trustedPackageJson = trusted;
      break;
    }
    if (directory === projectRoot) break;
    directory = dirname(directory);
  }
  if (!trustedPackageJson) return await runCommand(command, root, env);
  const packagePath = join(directory, 'package.json');
  const current = await readFile(packagePath, 'utf8');
  const currentPackage = JSON.parse(current) as Record<string, unknown>;
  const trustedPackage = JSON.parse(trustedPackageJson) as { scripts?: unknown };
  // The verification checkout is disposable, so no restoration is necessary.
  // Atomic replacement also cannot follow a package.json symlink introduced in
  // a race between validation and this write.
  atomicWriteFileSync(packagePath, `${JSON.stringify({ ...currentPackage, scripts: trustedPackage.scripts }, null, 2)}\n`);
  return await runCommand(command, root, env);
}

async function validateSandboxSymlinks(projectPath: string, sharedPaths: string[]): Promise<void> {
  const projectRoot = await realpath(projectPath);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      const path = relative(projectRoot, source);
      if (path.split(sep).some((segment) => segment === '.git' || segment === 'node_modules') || pathCoveredBy(path, sharedPaths)) continue;
      if (entry.isSymbolicLink()) {
        const target = await readlink(source);
        const resolvedTarget = resolve(dirname(source), target);
        if (isAbsolute(target) || (resolvedTarget !== projectRoot && !resolvedTarget.startsWith(`${projectRoot}${sep}`))) {
          throw new Error(`[security] verify sandbox rejects escaping symlink: ${path}`);
        }
        try {
          const realTarget = await realpath(source);
          if (realTarget !== projectRoot && !realTarget.startsWith(`${projectRoot}${sep}`)) {
            throw new Error(`[security] verify sandbox rejects escaping symlink: ${path}`);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`[security] verify sandbox rejects dangling symlink: ${path}`);
          }
          throw error;
        }
        continue;
      }
      if (entry.isDirectory()) await visit(source);
    }
  };
  await visit(projectRoot);
}

async function createHeadSandbox(projectPath: string, commands: VerifyCommand[]): Promise<{ root: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), 'openswarm-verify-head-'));
  const project = join(root, 'worktree');
  try {
    const headCommit = await git(projectPath, ['rev-parse', 'HEAD']);
    await git(projectPath, ['clone', '--quiet', '--no-hardlinks', '--no-checkout', projectPath, project]);
    await git(project, ['checkout', '--quiet', '--detach', headCommit]);
    const sharedPaths = await verificationSharedPaths(projectPath, commands);
    await validateSandboxSymlinks(projectPath, sharedPaths);
    // Mirror the source working tree exactly, including deletions and renames,
    // while retaining only the sandbox's independent Git metadata.
    for (const entry of await readdir(project)) {
      if (entry !== '.git') await rm(join(project, entry), { recursive: true, force: true });
    }
    await cp(projectPath, project, {
      recursive: true,
      force: true,
      // Node otherwise resolves relative links against the source and writes an
      // absolute link into the sandbox, which points back at the live checkout.
      verbatimSymlinks: true,
      filter: (source) => {
        const path = relative(projectPath, source);
        return path === '' || (
          !path.split(sep).some((segment) => segment === '.git' || segment === 'node_modules')
          && !pathCoveredBy(path, sharedPaths)
        );
      },
    });
    for (const sharedPath of sharedPaths) {
      await copyIsolatedPath(
        join(projectPath, sharedPath),
        join(project, sharedPath),
        project,
        sharedPath,
      );
    }
    // Validate what was actually copied, closing the source validation/copy
    // race before any repository-controlled command can execute.
    await validateSandboxSymlinks(project, sharedPaths);
    return { root, project };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function git(projectPath: string, args: string[]): Promise<string> {
  return await new Promise((resolveResult, reject) => {
    const maxOutputBytes = 4 * 1024 * 1024;
    const child = spawn('git', ['-C', projectPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(error);
    };
    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        fail(new Error(`git ${args[0] ?? ''} output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolveResult(stdout.trim());
      else reject(new Error(`git exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function runAtBase(
  projectPath: string,
  baseRef: string,
  command: VerifyCommand,
  trustedPackageJsonByDirectory?: Record<string, string>,
): Promise<CommandResult> {
  let root: string | undefined;
  let worktreePath: string | undefined;
  let worktreeAdded = false;
  try {
    const baseCommit = await git(projectPath, ['merge-base', 'HEAD', baseRef]);
    const changedFiles = await git(projectPath, ['diff', '--name-only', baseCommit, '--']);
    const untrackedFiles = await git(projectPath, ['ls-files', '--others', '--exclude-standard']);
    const dependencyChanges = `${changedFiles}\n${untrackedFiles}`.split('\n')
      .some((file) => DEPENDENCY_INPUTS.has(file.split('/').pop() ?? ''));
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-base-'));
    worktreePath = join(root, 'worktree');
    await git(projectPath, ['worktree', 'add', '--detach', worktreePath, baseCommit]);
    worktreeAdded = true;
    // A detached worktree intentionally has no ignored dependencies/data. Copy
    // them into the base sandbox so failed-check comparison cannot mutate the
    // HEAD checkout through a shared symlink.
    const sharedPaths = await verificationSharedPaths(projectPath, [command]);
    for (const sharedPath of sharedPaths) {
      const target = join(worktreePath, sharedPath);
      try {
        await access(target);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await copyIsolatedPath(join(projectPath, sharedPath), target, worktreePath, sharedPath);
    }
    const baseBin = join(worktreePath, 'node_modules', '.bin');
    const env = { ...process.env, PATH: `${baseBin}${delimiter}${process.env.PATH ?? ''}` };
    const result = await runTrustedCommand(command, worktreePath, trustedPackageJsonByDirectory, env);
    return { ...result, baselineEnvironmentChanged: dependencyChanges };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'infra', output: message.slice(-OUTPUT_TAIL_BYTES) };
  } finally {
    let canRemoveRoot = true;
    if (worktreePath && worktreeAdded) {
      await git(projectPath, ['worktree', 'remove', '--force', worktreePath]).catch((error) => {
        canRemoveRoot = false;
        console.warn(`[Verify] Failed to remove base worktree ${worktreePath}:`, error);
        console.warn(`[Verify] Preserving ${root} so Git worktree metadata does not point at a deleted path.`);
      });
    }
    if (root && canRemoveRoot) await rm(root, { recursive: true, force: true });
  }
}

export async function runVerify(options: RunVerifyOptions): Promise<VerifyEvidence[]> {
  const evidence: VerifyEvidence[] = [];
  for (const command of options.commands) {
    const started = Date.now();
    let sandbox: Awaited<ReturnType<typeof createHeadSandbox>>;
    try {
      sandbox = await createHeadSandbox(options.projectPath, [command]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith('[security]')) throw error;
      evidence.push({
        command, baseStatus: 'skipped', headStatus: 'fail', newFailure: true,
        rawOutputTail: message, durationMs: Date.now() - started,
      });
      continue;
    }
    try {
      const head = await runTrustedCommand(command, sandbox.project, options.trustedPackageJsonByDirectory);
      if (head.status === 'pass') {
        evidence.push({
          command,
          baseStatus: 'skipped',
          headStatus: 'pass',
          newFailure: false,
          rawOutputTail: head.output,
          durationMs: Date.now() - started,
        });
        continue;
      }
      if (head.status === 'infra') {
        evidence.push({
          command,
          baseStatus: 'skipped',
          headStatus: 'infra',
          newFailure: false,
          rawOutputTail: head.output,
          durationMs: Date.now() - started,
        });
        continue;
      }
      if (head.output.startsWith('[security]')) {
        evidence.push({
          command, baseStatus: 'skipped', headStatus: 'fail', newFailure: true,
          rawOutputTail: head.output, durationMs: Date.now() - started,
        });
        continue;
      }

      const base = await runAtBase(
        options.projectPath, options.baseRef, command, options.trustedPackageJsonByDirectory,
      );
      const rawOutputTail = Buffer.from(`[base]\n${base.output}\n[head]\n${head.output}`, 'utf8')
        .subarray(-OUTPUT_TAIL_BYTES)
        .toString('utf8');
      const sameFailure = base.status === 'fail' && hasSameFailure(base, head);
      const sameEnvironmentFailure = !!(sameFailure && base.environmentFailure && head.environmentFailure);
      evidence.push({
        command,
        baseStatus: base.status,
        headStatus: 'fail',
        newFailure: base.status === 'pass'
          || (base.status === 'fail' && (!sameFailure || (!!base.baselineEnvironmentChanged && !sameEnvironmentFailure))),
        rawOutputTail,
        durationMs: Date.now() - started,
      });
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  }
  return evidence;
}
