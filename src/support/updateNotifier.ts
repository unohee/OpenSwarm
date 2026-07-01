// ============================================
// OpenSwarm - Update notifier (INT-2270)
// ============================================
//
// Tell a user on an older version that a newer one is on npm. Reads a 24h cache
// (~/.openswarm/update-check.json) so almost every run is instant; at most once
// a day it does a short-timeout registry fetch. Silent on any error, non-TTY,
// CI, `--version`/`--help`, or `NO_UPDATE_NOTIFIER` — it must never slow down or
// break the CLI. The network/fs/clock are injectable for tests.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { c } from './colors.js';

const PKG = '@intrect/openswarm';
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_PATH = join(homedir(), '.openswarm', 'update-check.json');

interface UpdateCache {
  latest: string;
  checkedAt: number;
}

/** Numeric semver compare (pre-release tags ignored). `latest` strictly newer? Pure. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

/** Skip the check for non-interactive, CI, opted-out, or meta/help invocations. Pure. */
export function shouldSkip(argv: string[], env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (!isTTY) return true;
  if (env.CI || env.NO_UPDATE_NOTIFIER || env.OPENSWARM_NO_UPDATE_NOTIFIER) return true;
  const args = argv.slice(2);
  const META = new Set(['--version', '-V', '--help', '-h', 'help', 'completion']);
  if (args.some((a) => META.has(a))) return true;
  return false;
}

/** Fetch the latest published version from the npm registry (short timeout). */
async function fetchLatest(timeoutMs = 1200): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG}/latest`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readCache(): UpdateCache | null {
  try {
    const obj = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    return typeof obj?.latest === 'string' && typeof obj?.checkedAt === 'number' ? obj : null;
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCache): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
  } catch {
    // Cache is best-effort; a read-only home must not break the CLI.
  }
}

/** The two-line notice, styled with the shared console colors. Pure. */
export function formatUpdateNotice(current: string, latest: string): string {
  return (
    `\n  ${c.dim('Update available')} ${c.dim(current)} ${c.dim('→')} ${c.green(latest)}\n` +
    `  Run ${c.cyan(`npm i -g ${PKG}`)} to update.\n`
  );
}

export interface NotifierDeps {
  fetchLatest?: (timeoutMs?: number) => Promise<string | null>;
  readCache?: () => UpdateCache | null;
  writeCache?: (cache: UpdateCache) => void;
  now?: () => number;
  write?: (s: string) => void;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
}

/**
 * Print an "update available" notice if the running version is behind the latest
 * on npm. Uses the 24h cache; only fetches when the cache is stale (and backs off
 * — stamping checkedAt even on a failed fetch — so it never refetches every run).
 * Never throws. (INT-2270)
 */
export async function maybeNotifyUpdate(current: string, deps: NotifierDeps = {}): Promise<void> {
  try {
    const argv = deps.argv ?? process.argv;
    const env = deps.env ?? process.env;
    const isTTY = deps.isTTY ?? !!process.stdout.isTTY;
    if (shouldSkip(argv, env, isTTY)) return;

    const now = deps.now ?? (() => Date.now());
    const read = deps.readCache ?? readCache;
    const write = deps.writeCache ?? writeCache;
    const fetchFn = deps.fetchLatest ?? fetchLatest;
    const out = deps.write ?? ((s: string) => process.stderr.write(s));

    const cache = read();
    let latest = cache?.latest ?? null;
    const fresh = cache != null && now() - cache.checkedAt < DAY_MS;

    if (!fresh) {
      const fetched = await fetchFn();
      // Back off even on failure (reuse the last known latest, or the current
      // version) so a registry hiccup doesn't make every run hit the network.
      write({ latest: fetched ?? latest ?? current, checkedAt: now() });
      if (fetched) latest = fetched;
    }

    if (latest && isNewer(latest, current)) out(formatUpdateNotice(current, latest));
  } catch {
    // A notifier must never break the CLI.
  }
}
