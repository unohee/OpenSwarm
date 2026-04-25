// ============================================
// OpenSwarm - Daemon (detached start/stop/status)
// ============================================
//
// `openswarm start` spawns a detached child that runs the full service (index.js
// → startService), redirects stdout/stderr to a log file, writes a PID file,
// and exits the parent. `openswarm stop` reads the PID file and sends SIGTERM.
// `openswarm status` reports running/stopped plus port 3847 health.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_DIR = join(homedir(), '.config', 'openswarm');
const LOG_DIR = join(STATE_DIR, 'logs');
const PID_FILE = join(STATE_DIR, 'openswarm.pid');
const LOG_FILE = join(LOG_DIR, 'openswarm.log');

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  uptimeSeconds?: number;
  pidFile: string;
  logFile: string;
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
 * Resolve the path to dist/index.js. daemon.js lives at dist/cli/daemon.js,
 * so index.js is one level up.
 */
function resolveIndexPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'index.js');
}

/**
 * Start the service as a detached background process.
 * Returns the child PID on success.
 * Throws if a daemon is already running.
 */
export function startDaemon(): { pid: number; logFile: string } {
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

  const indexPath = resolveIndexPath();
  if (!existsSync(indexPath)) {
    throw new Error(`Service entrypoint not found: ${indexPath}`);
  }

  // Open log file for append; reuse the same fd for stdout and stderr so logs
  // are interleaved in order.
  const logFd = openSync(LOG_FILE, 'a');

  const child = spawn(process.execPath, [indexPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    // Run from the user's home so relative paths in the service don't depend
    // on the shell that invoked `openswarm start`.
    cwd: homedir(),
    env: { ...process.env, OPENSWARM_DAEMON: '1' },
  });

  if (child.pid === undefined) {
    throw new Error('Failed to spawn daemon process (no pid assigned).');
  }

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

export const DAEMON_PATHS = { STATE_DIR, LOG_DIR, PID_FILE, LOG_FILE } as const;
