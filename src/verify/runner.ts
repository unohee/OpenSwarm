import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { isInfraError } from '../adapters/errorClassification.js';
import type { VerifyCommand } from './manifest.js';

const OUTPUT_TAIL_BYTES = 8 * 1024;
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
  baselineEnvironmentChanged?: boolean;
}

function hasSameFailure(base: CommandResult, head: CommandResult): boolean {
  // A shared non-zero exit code is not enough to prove that the failure is
  // pre-existing: HEAD may contain the old failure plus a new regression.
  // Only waive the failure when the observable failure output is identical.
  // Commands with unstable output therefore fail closed and require review.
  return base.outputFingerprint !== undefined && base.outputFingerprint === head.outputFingerprint;
}

function appendTail(current: Buffer, chunk: Buffer): Buffer {
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= OUTPUT_TAIL_BYTES ? combined : combined.subarray(combined.length - OUTPUT_TAIL_BYTES);
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
  const shell = process.env.SHELL || '/bin/sh';
  return await new Promise((resolveResult) => {
    let output: Buffer = Buffer.alloc(0);
    const outputHash = createHash('sha256');
    let settled = false;
    let timedOut = false;
    const detached = process.platform !== 'win32';
    const child = spawn(shell, ['-lc', command.run], {
      cwd,
      env,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => { outputHash.update(chunk); output = appendTail(output, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { outputHash.update(chunk); output = appendTail(output, chunk); });

    const finish = (status: CommandResult['status'], extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (extra) { outputHash.update(extra); output = appendTail(output, Buffer.from(extra)); }
      resolveResult({ status, output: output.toString('utf8'), outputFingerprint: outputHash.digest('hex') });
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
    });
  });
}

async function runTrustedCommand(
  command: VerifyCommand,
  root: string,
  trustedPackageJsonByDirectory: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  if (Object.keys(trustedPackageJsonByDirectory).length === 0) return await runCommand(command, root, env);
  const projectRoot = resolve(root);
  let directory = resolve(projectRoot, command.cwd ?? '.');
  let trustedPackageJson: string | undefined;
  while (directory === projectRoot || directory.startsWith(`${projectRoot}${sep}`)) {
    const key = relative(projectRoot, directory);
    const trusted = trustedPackageJsonByDirectory[key];
    const actual = await readFile(join(directory, 'package.json'), 'utf8').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
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
  try {
    const currentPackage = JSON.parse(current) as Record<string, unknown>;
    const trustedPackage = JSON.parse(trustedPackageJson) as { scripts?: unknown };
    // Pin only lifecycle definitions. HEAD dependency/module/export metadata
    // remains under test while worker-mutated scripts cannot weaken the gate.
    await writeFile(packagePath, `${JSON.stringify({ ...currentPackage, scripts: trustedPackage.scripts }, null, 2)}\n`, 'utf8');
    return await runCommand(command, root, env);
  } finally {
    await writeFile(packagePath, current, 'utf8');
  }
}

async function createHeadSandbox(projectPath: string, commands: VerifyCommand[]): Promise<{ root: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), 'openswarm-verify-head-'));
  const project = join(root, 'worktree');
  try {
    const headCommit = await git(projectPath, ['rev-parse', 'HEAD']);
    await git(projectPath, ['clone', '--quiet', '--no-hardlinks', '--no-checkout', projectPath, project]);
    await git(project, ['checkout', '--quiet', '--detach', headCommit]);
    // Mirror the source working tree exactly, including deletions and renames,
    // while retaining only the sandbox's independent Git metadata.
    for (const entry of await readdir(project)) {
      if (entry !== '.git') await rm(join(project, entry), { recursive: true, force: true });
    }
    await cp(projectPath, project, {
      recursive: true,
      force: true,
      filter: (source) => {
        const path = relative(projectPath, source);
        return path === '' || !path.split(sep).some((segment) => segment === '.git' || segment === 'node_modules');
      },
    });
    const dependencyDirs = new Set(['', ...commands.map((command) => command.cwd ?? '')]);
    for (const directory of dependencyDirs) {
      const source = join(projectPath, directory, 'node_modules');
      const target = join(project, directory, 'node_modules');
      try {
        await access(source);
        await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return { root, project };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function git(projectPath: string, args: string[]): Promise<string> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn('git', ['-C', projectPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolveResult(stdout.trim())
      : reject(new Error(`git exited with code ${code}: ${stderr.trim()}`)));
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
  try {
    const baseCommit = await git(projectPath, ['merge-base', 'HEAD', baseRef]);
    const changedFiles = await git(projectPath, ['diff', '--name-only', baseCommit, '--']);
    const untrackedFiles = await git(projectPath, ['ls-files', '--others', '--exclude-standard']);
    const dependencyChanges = `${changedFiles}\n${untrackedFiles}`.split('\n')
      .some((file) => DEPENDENCY_INPUTS.has(file.split('/').pop() ?? ''));
    root = await mkdtemp(join(tmpdir(), 'openswarm-verify-base-'));
    worktreePath = join(root, 'worktree');
    await git(projectPath, ['worktree', 'add', '--detach', worktreePath, baseCommit]);
    // Package scripts resolve dependencies relative to cwd, not only through
    // PATH. A detached worktree intentionally has no ignored node_modules, so
    // expose the already-installed HEAD dependencies to make base and head run
    // under the same toolchain without mutating the baseline checkout.
    const headNodeModules = join(projectPath, 'node_modules');
    try {
      await access(headNodeModules);
      await symlink(headNodeModules, join(worktreePath, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const headBin = join(projectPath, 'node_modules', '.bin');
    const env = { ...process.env, PATH: `${headBin}${delimiter}${process.env.PATH ?? ''}` };
    const result = await runTrustedCommand(command, worktreePath, trustedPackageJsonByDirectory, env);
    return { ...result, baselineEnvironmentChanged: dependencyChanges };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'infra', output: message.slice(-OUTPUT_TAIL_BYTES) };
  } finally {
    if (worktreePath) {
      await git(projectPath, ['worktree', 'remove', '--force', worktreePath]).catch((error) => {
        console.warn(`[Verify] Failed to remove base worktree ${worktreePath}:`, error);
      });
    }
    if (root) await rm(root, { recursive: true, force: true });
  }
}

export async function runVerify(options: RunVerifyOptions): Promise<VerifyEvidence[]> {
  const evidence: VerifyEvidence[] = [];
  const sandbox = await createHeadSandbox(options.projectPath, options.commands);
  try {
  for (const command of options.commands) {
    const started = Date.now();
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
    evidence.push({
      command,
      baseStatus: base.status,
      headStatus: 'fail',
      newFailure: base.status === 'pass'
        || (base.status === 'fail' && (base.baselineEnvironmentChanged || !hasSameFailure(base, head))),
      rawOutputTail,
      durationMs: Date.now() - started,
    });
  }
  return evidence;
  } finally {
    await rm(sandbox.root, { recursive: true, force: true });
  }
}
