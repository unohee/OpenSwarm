// ============================================
// OpenSwarm - Daemon (detached start/stop/status)
// ============================================
//
// `openswarm start` spawns a detached child that runs the full service (index.js
// → startService), redirects stdout/stderr to a log file, writes a PID file,
// and exits the parent. `openswarm stop` reads the PID file and sends SIGTERM.
// `openswarm status` reports running/stopped plus port 3847 health.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_DIR = join(homedir(), '.config', 'openswarm');
const LOG_DIR = join(STATE_DIR, 'logs');
const PID_FILE = join(STATE_DIR, 'openswarm.pid');
const LOG_FILE = join(LOG_DIR, 'openswarm.log');
const DAEMON_PORT = 3847;

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  uptimeSeconds?: number;
  pidFile: string;
  logFile: string;
  /** True when no PID file matched but the daemon API answered — a launchd-managed or manually started instance. */
  external?: boolean;
}

function ensureStateDirs(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return pid;
}

/**
 * Probe the daemon's HTTP API directly. The PID file only tracks daemons
 * spawned by `openswarm start` — a launchd-managed (or manually run) instance
 * never writes it, so PID-file-only detection reports "not running" while a
 * daemon is actively serving. That mis-detection made the TUI auto-start spawn
 * a SECOND daemon working the same Linear queue in parallel (INT-2473).
 * The port answers for any daemon regardless of how it was started.
 */
export async function probeDaemonPort(port = DAEMON_PORT, timeoutMs = 800): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/stats`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve the path to dist/index.js. daemon.js lives at dist/cli/daemon.js,
 * so index.js is one level up.
 */
function resolveIndexPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'index.js');
}

function closeFdQuietly(fd: number): void {
  try { closeSync(fd); } catch { /* ignore */ }
}

/**
 * Start the service as a detached background process.
 * Returns the child PID on success.
 * Throws if a daemon is already running (PID file OR port 3847 responding).
 */
export async function startDaemon(): Promise<{ pid: number; logFile: string }> {
  ensureStateDirs();

  const existing = readPidFile();
  if (existing !== null && isProcessAlive(existing)) {
    throw new Error(
      `OpenSwarm is already running (pid ${existing}). ` +
      `Run 'openswarm stop' first or 'openswarm status' to check.`
    );
  }
  if (existing !== null) {
    // Stale pid file — previous run crashed without cleaning up.
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  }

  // No PID file, but the API may still be live: a launchd-managed or manually
  // started daemon. Spawning another would double-process the same task queue.
  if (await probeDaemonPort()) {
    throw new Error(
      `OpenSwarm is already serving port ${DAEMON_PORT} (externally managed — e.g. launchd). ` +
      `Not spawning a duplicate. Use 'launchctl kickstart -k gui/$UID/com.intrect.openswarm' to restart it.`
    );
  }

  const indexPath = resolveIndexPath();
  if (!existsSync(indexPath)) {
    throw new Error(`Service entrypoint not found: ${indexPath}`);
  }

  // Open log file for append; reuse the same fd for stdout and stderr so logs
  // are interleaved in order.
  const logFd = openSync(LOG_FILE, 'a');

  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [indexPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      // Run from the user's home so relative paths in the service don't depend
      // on the shell that invoked `openswarm start`.
      cwd: homedir(),
      env: { ...process.env, OPENSWARM_DAEMON: '1' },
    });
  } catch (err) {
    closeFdQuietly(logFd);
    throw err;
  }

  if (child.pid === undefined) {
    closeFdQuietly(logFd);
    throw new Error('Failed to spawn daemon process (no pid assigned).');
  }

  closeFdQuietly(logFd);
  writeFileSync(PID_FILE, String(child.pid), { mode: 0o644 });

  // Let the child outlive this process.
  child.unref();

  return { pid: child.pid, logFile: LOG_FILE };
}

/**
 * Signal the running daemon to shut down. Returns false if no daemon is running.
 * Waits up to `timeoutMs` for the process to exit; returns true once it does,
 * or throws if it's still alive after the timeout.
 */
export async function stopDaemon(timeoutMs = 10_000): Promise<boolean> {
  const pid = readPidFile();
  if (pid === null) return false;

  if (!isProcessAlive(pid)) {
    // Stale pid file.
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return false;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    throw new Error(`Failed to signal pid ${pid}: ${(err as Error).message}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      try { unlinkSync(PID_FILE); } catch { /* ignore */ }
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(
    `Daemon (pid ${pid}) did not exit within ${timeoutMs}ms. ` +
    `It may still be shutting down; retry 'openswarm status' shortly or send SIGKILL manually.`
  );
}

/**
 * Read the last `lines` lines of the daemon log. Used by `openswarm start` to
 * show why the daemon exited when it dies during startup.
 */
export function readLogTail(lines = 20): string {
  try {
    const content = readFileSync(LOG_FILE, 'utf8');
    return content.split('\n').slice(-lines).join('\n').trimEnd();
  } catch {
    return '(log file unavailable)';
  }
}

export function getDaemonStatus(): DaemonStatus {
  const pid = readPidFile();
  if (pid === null || !isProcessAlive(pid)) {
    return { running: false, pidFile: PID_FILE, logFile: LOG_FILE };
  }

  let uptimeSeconds: number | undefined;
  try {
    const stat = statSync(PID_FILE);
    uptimeSeconds = Math.floor((Date.now() - stat.mtimeMs) / 1000);
  } catch { /* ignore */ }

  return { running: true, pid, uptimeSeconds, pidFile: PID_FILE, logFile: LOG_FILE };
}

/**
 * Like getDaemonStatus, but also detects daemons the PID file can't see
 * (launchd-managed / manually started) by probing the API port. Prefer this
 * anywhere the answer gates spawning a new daemon.
 */
export async function getDaemonStatusFull(): Promise<DaemonStatus> {
  const base = getDaemonStatus();
  if (base.running) return base;
  if (await probeDaemonPort()) {
    return { running: true, external: true, pidFile: PID_FILE, logFile: LOG_FILE };
  }
  return base;
}

export const DAEMON_PATHS = { STATE_DIR, LOG_DIR, PID_FILE, LOG_FILE } as const;
