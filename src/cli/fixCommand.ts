// ============================================
// OpenSwarm - `openswarm fix` — CI/test gate fan-out auto-fix (INT-2267)
// ============================================
//
// Run the project's objective checks (lint / typecheck / build / test), group
// the failures by file into areas, fan a fix-worker out over each area (same
// concurrency machinery as `review --max`), then RE-RUN the checks and repeat
// until green or the round budget runs out. Unlike `review --max --fix` (an LLM
// opinion, no re-verify), the checks are deterministic so the loop can actually
// converge. Edits land in the working tree — the user reviews the diff.
//
// Pure pieces (resolveChecks / parseFailingFiles / deriveFixAreas /
// buildFixCheckTask) are unit-tested; the orchestration shell wires spawn +
// runWorker + the concurrency pool (all injectable).

import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { balanceAreasToConcurrency } from './reviewAudit.js';
import { runPool } from '../support/concurrencyPool.js';
import { startProgressHeartbeat } from './reviewProgress.js';
import { status, c } from '../support/colors.js';
import type { AdapterName } from '../adapters/types.js';

/** A resolvable objective check (`npm run lint`, `npm test`, …). */
export interface Check {
  key: string;
  program: string;
  args: string[];
}

/** The result of running one check, with the source files its output blamed. */
export interface CheckOutcome {
  key: string;
  passed: boolean;
  output: string;
  files: string[];
}

/** One fix unit: a directory-shaped area plus the failing-check output for it. */
export interface FixArea {
  label: string;
  dir: string;
  files: string[];
  failures: string[];
}

/** The named checks `--checks` understands, mapped to a package.json script. */
const KNOWN_CHECKS: Record<string, string> = {
  lint: 'lint',
  type: 'typecheck',
  typecheck: 'typecheck',
  build: 'build',
  test: 'test',
};
const DEFAULT_ORDER = ['lint', 'typecheck', 'build', 'test'];

/**
 * Resolve named checks to `npm run <script>` commands using the repo's
 * package.json scripts. `requested` is the `--checks` list (keys); when omitted,
 * every default check that has a script is used. Unknown/missing scripts are
 * dropped. Pure.
 */
export function resolveChecks(scripts: Record<string, string>, requested?: string[]): Check[] {
  const keys = requested?.length
    ? requested.map((k) => KNOWN_CHECKS[k.trim()] ?? k.trim())
    : DEFAULT_ORDER.filter((k) => k in scripts);
  const seen = new Set<string>();
  const checks: Check[] = [];
  for (const script of keys) {
    if (seen.has(script) || !(script in scripts)) continue;
    seen.add(script);
    checks.push({ key: script, program: 'npm', args: ['run', script] });
  }
  return checks;
}

/** Read `<cwd>/package.json` scripts (empty when absent/unparseable). */
export function readScripts(cwd: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    return pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  } catch {
    return {};
  }
}

const SOURCE_EXT = 'tsx?|jsx?|mjs|cjs|py|rs|go|java|kt|kts|scala|rb|php|swift|c|cc|cpp|cxx|h|hpp|cs|ex|exs|lua|jl|zig|nim';
const FILE_RE = new RegExp(String.raw`(?:^|[\s('"\`])((?:[\w.\-]+\/)*[\w.\-]+\.(?:${SOURCE_EXT}))`, 'g');

/**
 * Extract repo-relative source file paths mentioned in check output — the files
 * to hand the fix worker. Language-agnostic: matches any path ending in a source
 * extension (tsc `file.ts(1,2)`, vitest `FAIL file.test.ts`, eslint `file:1:1`,
 * pytest `file.py::test`). Pure; caller filters to files that exist. Deduped,
 * `./` stripped.
 */
export function parseFailingFiles(output: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(FILE_RE)) {
    let p = m[1];
    while (p.startsWith('./')) p = p.slice(2);
    if (p && !p.startsWith('/')) out.add(p);
  }
  return [...out];
}

const truncate = (s: string, n: number): string => (s.length <= n ? s : `…${s.slice(-n)}`);

/**
 * Group failing checks into fix areas. Files blamed across the failing checks
 * are partitioned into directory areas (sized to fill the pool); each area
 * carries the check output relevant to its files. A failing check whose output
 * has no parseable file (e.g. a bare build error) becomes its own `check:<key>`
 * area with the raw output. Pure.
 */
export function deriveFixAreas(failing: CheckOutcome[], concurrency: number, maxFilesPerArea = 8): FixArea[] {
  const areas: FixArea[] = [];
  const allFiles = [...new Set(failing.flatMap((f) => f.files))];

  if (allFiles.length) {
    for (const a of balanceAreasToConcurrency(allFiles, concurrency, maxFilesPerArea)) {
      const relevant = failing.filter((f) => f.files.some((file) => a.files.includes(file)));
      const src = relevant.length ? relevant : failing;
      areas.push({
        label: a.label,
        dir: a.dir,
        files: a.files,
        failures: src.map((f) => `[${f.key}]\n${truncate(f.output, 3000)}`),
      });
    }
  }

  for (const f of failing.filter((f) => f.files.length === 0)) {
    areas.push({ label: `check:${f.key}`, dir: '.', files: [], failures: [`[${f.key}]\n${truncate(f.output, 3000)}`] });
  }
  return areas;
}

/** Build the fix worker's task: the failing output + a hard "verify, don't cheat" rule. */
export function buildFixCheckTask(area: FixArea, checks: Check[]): string {
  const verify = checks.map((c) => `${c.program} ${c.args.join(' ')}`).join(' && ');
  return [
    `The project's checks are failing. Apply the MINIMAL edits needed to make them pass.`,
    area.files.length
      ? `Files in scope (edit only these — the failures are theirs):\n${area.files.map((f) => `- ${f}`).join('\n')}`
      : `No single file scope — find and fix the root cause of the failure below.`,
    ``,
    `Failing check output:`,
    ...area.failures.map((f) => '```\n' + f + '\n```'),
    ``,
    `Re-run \`${verify}\` to confirm before finishing. Do NOT weaken, skip, or delete tests/checks to make them pass — fix the actual cause.`,
  ].join('\n');
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface FixOptions {
  path?: string;
  checks?: string[];
  concurrency?: number;
  rounds?: number;
  adapter?: AdapterName;
  maxFilesPerArea?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FixDeps {
  /** Run one check → {passed, output}. Default spawns the command. Injectable. */
  runCheck?: (check: Check, cwd: string) => Promise<{ passed: boolean; output: string }>;
  /** Apply one area's fixes → {success, filesChanged}. Default spawns a worker. Injectable. */
  runFixWorker?: (area: FixArea, checks: Check[], onLog: (l: string) => void) => Promise<{ success: boolean; filesChanged: string[] }>;
  /** Override the resolved checks (tests). */
  checks?: Check[];
  /** File-existence predicate (tests). Default fs.existsSync under cwd. */
  exists?: (relPath: string, cwd: string) => boolean;
  log?: (line: string) => void;
}

export interface RoundReport {
  round: number;
  outcomes: CheckOutcome[];
  filesChanged: string[];
}
export interface FixReport {
  green: boolean;
  rounds: RoundReport[];
  reason?: 'green' | 'out-of-rounds' | 'no-progress' | 'no-checks';
}

/** Default check runner: spawn the command, capture combined output, pass = exit 0. */
async function defaultRunCheck(check: Check, cwd: string): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(check.program, check.args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ passed: !err, output: `${stdout ?? ''}${stderr ?? ''}` });
    });
  });
}

async function defaultRunFixWorker(
  area: FixArea,
  checks: Check[],
  cwd: string,
  opts: FixOptions,
  onLog: (l: string) => void,
): Promise<{ success: boolean; filesChanged: string[] }> {
  const { runWorker } = await import('../agents/worker.js');
  const r = await runWorker({
    taskTitle: `Fix failing checks: ${area.label}`,
    taskDescription: buildFixCheckTask(area, checks),
    projectPath: cwd,
    adapterName: opts.adapter,
    timeoutMs: opts.timeoutMs,
    nudgeMaxOnNoEdit: 1,
    signal: opts.signal,
    onLog,
  });
  return { success: r.success, filesChanged: r.filesChanged };
}

/** Run every check (sequentially — they contend for CPU/FS), blaming files from output. */
async function runAllChecks(
  checks: Check[],
  cwd: string,
  runCheck: NonNullable<FixDeps['runCheck']>,
  exists: (p: string, cwd: string) => boolean,
  log: (l: string) => void,
): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  for (const check of checks) {
    const tty = !!process.stderr.isTTY;
    const hb = tty ? startProgressHeartbeat(`${check.key}…`) : null;
    const { passed, output } = await runCheck(check, cwd);
    hb?.stop();
    const files = passed ? [] : parseFailingFiles(output).filter((f) => exists(f, cwd));
    outcomes.push({ key: check.key, passed, output, files });
    log(passed ? `  ${status.ok(check.key)}` : `  ${status.err(`${check.key} — ${files.length} file(s)`)}`);
  }
  return outcomes;
}

/**
 * Run checks → fan out fixes → re-run, until green or the round/progress budget
 * is spent. Returns a structured report; the CLI turns it into an exit code.
 */
export async function runFixCommand(opts: FixOptions = {}, deps: FixDeps = {}): Promise<FixReport> {
  const cwd = opts.path ?? process.cwd();
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const maxRounds = Math.max(1, opts.rounds ?? 3);
  const log = deps.log ?? ((l: string) => console.log(l));
  const exists = deps.exists ?? ((p, base) => existsSync(join(base, p)));
  const runCheck = deps.runCheck ?? defaultRunCheck;
  const runFixWorker = deps.runFixWorker ?? ((area, checks, onLog) => defaultRunFixWorker(area, checks, cwd, opts, onLog));
  const checks = deps.checks ?? resolveChecks(readScripts(cwd), opts.checks);

  if (!checks.length) {
    log(status.warn('No checks resolved — add lint/typecheck/build/test scripts to package.json, or pass --checks.'));
    return { green: false, rounds: [], reason: 'no-checks' };
  }

  log(c.bold(`\nRunning ${checks.length} check(s): ${checks.map((ch) => ch.key).join(', ')} · concurrency ${concurrency} · up to ${maxRounds} round(s)\n`));

  const rounds: RoundReport[] = [];
  let prevFailKey = '';

  for (let round = 1; round <= maxRounds; round++) {
    log(c.dim(`── round ${round}/${maxRounds} ──`));
    const outcomes = await runAllChecks(checks, cwd, runCheck, exists, log);
    const failing = outcomes.filter((o) => !o.passed);

    if (!failing.length) {
      rounds.push({ round, outcomes, filesChanged: [] });
      log(`\n${status.ok(`All ${checks.length} check(s) passing.`)}`);
      return { green: true, rounds, reason: 'green' };
    }

    if (round === maxRounds) {
      rounds.push({ round, outcomes, filesChanged: [] });
      break;
    }

    const areas = deriveFixAreas(failing, concurrency, opts.maxFilesPerArea);
    log(`\nFixing ${failing.length} failing check(s) across ${areas.length} area(s)...`);
    const settled = await runPool(areas, concurrency, async (area) => {
      const r = await runFixWorker(area, checks, () => {});
      log(r.filesChanged.length ? `  ${status.ok(`${area.label} — ${r.filesChanged.length} file(s)`)}` : `  ${status.warn(`${area.label} — no edit`)}`);
      return r;
    });
    const filesChanged = [...new Set(settled.flatMap((s) => s.value?.filesChanged ?? []))];
    rounds.push({ round, outcomes, filesChanged });

    const failKey = failing.map((f) => f.key).sort().join(',');
    if (failKey === prevFailKey && filesChanged.length === 0) {
      log(`\n${status.warn('No progress this round (same failures, no edits) — stopping.')}`);
      return { green: false, rounds, reason: 'no-progress' };
    }
    prevFailKey = failKey;
  }

  const lastFailing = rounds.at(-1)?.outcomes.filter((o) => !o.passed) ?? [];
  log(`\n${status.err(`Still failing after ${maxRounds} round(s): ${lastFailing.map((o) => o.key).join(', ')}.`)}`);
  log(c.dim('Changes are in the working tree — review the diff.'));
  return { green: false, rounds, reason: 'out-of-rounds' };
}
