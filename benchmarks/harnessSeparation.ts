#!/usr/bin/env tsx
// ============================================
// OpenSwarm - Phase 0: Harness Separation Benchmark (INT-1675)
// Created: 2026-06-24
// Purpose: GO/NoGo gate — separates harness overhead from model quality.
//
// 4 conditions measured across L0–L5:
//   ① qwen3-235b via openrouter (current non-frontier regime)
//   ② codex-responses adapter (current non-frontier regime, uses openswarm agentic loop)
//   ③ claude -p (ceiling baseline — black-box CLI)
//   ④ same model split:
//       (a) anthropic/claude-sonnet-4 via claude -p   → ceiling
//       (b) anthropic/claude-sonnet-4 via openrouter  → openswarm agentic loop
//
// Key metric: ④(a) − ④(b) = pure harness overhead (model held constant).
//
// Decision gate:
//   ④b ≈ ④a  → gap is model, not harness → epic INT-1674 폐기, route hard tasks to claude -p
//   ④b ≪ ④a  → gap is harness → Phase 1+ proceed, prioritise by gap size
//
// Usage:
//   npx tsx benchmarks/harnessSeparation.ts --conditions qwen,claude --repeat 1
//   npx tsx benchmarks/harnessSeparation.ts  # all 4 conditions, 1 repeat each
// ============================================

import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runWorker } from '../src/agents/worker.js';
import { setDefaultAdapter } from '../src/adapters/index.js';
import { initLocale } from '../src/locale/index.js';
import { loadEnvFile } from '../src/core/envFile.js';
import { CODING_TASKS, type BenchTask } from './tasks/codingTasks.js';

const exec = promisify(execFile);

// Condition definitions

interface Condition {
  id: string;
  label: string;
  adapter: 'openrouter' | 'claude' | 'codex-responses';
  model?: string;  // undefined = adapter default
}

const ALL_CONDITIONS: Condition[] = [
  {
    // qwen3-235b is blocked by OpenRouter data policy; kimi-k2.5 is the
    // most-validated non-frontier model (100% L0-L5, RUBRIC.md) and serves
    // the same measurement role: non-frontier model through the openswarm harness.
    id: 'kimi-k2.5',
    label: '① kimi-k2.5 (OR)',
    adapter: 'openrouter',
    model: 'moonshotai/kimi-k2.5',
  },
  {
    id: 'codex-responses',
    label: '② codex-responses',
    adapter: 'codex-responses',
    model: undefined,  // adapter picks gpt-5.5
  },
  {
    id: 'claude-ceiling',
    label: '③ claude -p (ceiling)',
    adapter: 'claude',
    model: undefined,  // claude CLI default
  },
  {
    // claude CLI accepts the alias "sonnet" which resolves to the latest claude-sonnet
    // (same as ③ but kept separate to make the ④a/④b pair explicit in the report).
    id: 'claude-sonnet-claude',
    label: '④a claude-sonnet-4 via claude -p',
    adapter: 'claude',
    model: undefined,  // use default alias "sonnet" — explicitly equivalent to claude-sonnet-4
  },
  {
    id: 'claude-sonnet-or',
    label: '④b claude-sonnet-4 via openrouter',
    adapter: 'openrouter',
    model: 'anthropic/claude-sonnet-4',
  },
];

interface RunResult {
  conditionId: string;
  conditionLabel: string;
  adapter: string;
  model: string;
  taskId: string;
  level: string;
  rep: number;
  passed: boolean;
  reason: string;
  toolCalls: number;
  editCalls: number;
  apiError: boolean;
  failClass: string;
  durationMs: number;
}

function levelOf(taskId: string): string {
  const m = taskId.match(/^(L\d)/);
  return m ? m[1] : '?';
}

function classify(r: { passed: boolean; toolCalls: number; editCalls: number; apiError: boolean }): string {
  if (r.passed) return 'pass';
  if (r.apiError && r.toolCalls === 0) return 'api-error';
  if (r.toolCalls === 0) return 'no-tool-call';
  if (r.editCalls === 0) return 'explore-no-edit';
  return 'wrong-edit';
}

async function setupRepo(task: BenchTask): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hs0-'));
  for (const [rel, content] of Object.entries(task.files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  await exec('git', ['init', '-q'], { cwd: dir });
  await exec('git', ['config', 'user.email', 'bench@local'], { cwd: dir });
  await exec('git', ['config', 'user.name', 'bench'], { cwd: dir });
  await exec('git', ['add', '-A'], { cwd: dir });
  await exec('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

async function runOne(
  condition: Condition,
  task: BenchTask,
  rep: number,
  timeoutMs: number,
  nudge: number,
): Promise<RunResult> {
  setDefaultAdapter(condition.adapter);
  const dir = await setupRepo(task);
  const logs: string[] = [];
  const t0 = Date.now();
  let apiError = false;

  try {
    const res = await runWorker({
      taskTitle: task.title,
      taskDescription: task.description,
      projectPath: dir,
      adapterName: condition.adapter,
      model: condition.model,
      timeoutMs,
      maxTurns: 20,
      nudgeMaxOnNoEdit: nudge,
      webTools: false,
      onLog: (l) => logs.push(l),
    });
    const txt = (res.summary ?? '') + (res.error ?? '');
    if (/API error|rate.?limit|429|502|Insufficient credits|quota/i.test(txt)) {
      apiError = true;
    }
  } catch (err) {
    logs.push(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    apiError = true;
  }

  const durationMs = Date.now() - t0;

  const read = (rel: string): string | null => {
    try { return readFileSync(join(dir, rel), 'utf-8'); } catch { return null; }
  };
  const verdict = task.check(read, dir);

  const toolCalls = logs.filter((l) => l.includes('🔧')).length;
  const editCalls = logs.filter((l) => l.includes('🔧') && /edit_file|write_file/.test(l)).length;
  if (logs.some((l) => /API error|rate.?limit|Insufficient credits|\b429\b|\b502\b/i.test(l))) {
    apiError = true;
  }

  await rm(dir, { recursive: true, force: true });

  const base = { passed: verdict.passed, toolCalls, editCalls, apiError };
  return {
    conditionId: condition.id,
    conditionLabel: condition.label,
    adapter: condition.adapter,
    model: condition.model ?? '(default)',
    taskId: task.id,
    level: levelOf(task.id),
    rep,
    passed: verdict.passed,
    reason: verdict.reason,
    toolCalls,
    editCalls,
    apiError,
    failClass: classify(base),
    durationMs,
  };
}

function pct(p: number, d: number): string {
  return d > 0 ? `${Math.round((p / d) * 100)}%` : '-';
}

function buildReport(results: RunResult[], conditions: Condition[]): string {
  const levels = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
  const lines: string[] = [];

  lines.push('# Phase 0 — Harness Separation Benchmark');
  lines.push('');
  lines.push('## 4×6 Pass-rate Table (condition × level)');
  lines.push('');
  const header = `| condition | ${levels.join(' | ')} | ALL |`;
  const sep = `|---|${levels.map(() => '---').join('|')}|---|`;
  lines.push(header);
  lines.push(sep);

  for (const cond of conditions) {
    const rs = results.filter((r) => r.conditionId === cond.id);
    const cells = levels.map((l) => {
      const sub = rs.filter((r) => r.level === l);
      return sub.length ? pct(sub.filter((r) => r.passed).length, sub.length) : '-';
    });
    const all = pct(rs.filter((r) => r.passed).length, rs.length);
    lines.push(`| ${cond.label} | ${cells.join(' | ')} | ${all} |`);
  }
  lines.push('');

  // Harness overhead: ④a vs ④b
  lines.push('## Harness Ceiling (④a vs ④b — same model, different adapter)');
  lines.push('');
  const cA = results.filter((r) => r.conditionId === 'claude-sonnet-claude');
  const cB = results.filter((r) => r.conditionId === 'claude-sonnet-or');

  if (cA.length > 0 && cB.length > 0) {
    const prA = cA.filter((r) => r.passed).length / cA.length;
    const prB = cB.filter((r) => r.passed).length / cB.length;
    const gapPct = Math.round((prA - prB) * 100);
    lines.push(`- claude-sonnet-4 via **claude -p** (④a): ${pct(cA.filter(r => r.passed).length, cA.length)}`);
    lines.push(`- claude-sonnet-4 via **openrouter** (④b): ${pct(cB.filter(r => r.passed).length, cB.length)}`);
    lines.push(`- **Harness gap: ${gapPct >= 0 ? '+' : ''}${gapPct}pp** (④a − ④b)`);
    lines.push('');

    const gapBig = Math.abs(gapPct) >= 15;
    if (gapBig) {
      lines.push('**→ GO: harness overhead is significant. Phase 1+ warranted.**');
      lines.push('Phase priority: harness gap = model + harness share; proceed with Phase 1 (edit tooling).');
    } else {
      lines.push('**→ NoGo: gap is small. Difference is model-driven, not harness-driven.**');
      lines.push('Recommendation: CLOSE epic INT-1674; route hard tasks to claude -p directly.');
    }
    lines.push('');

    // Per-level breakdown of the gap
    lines.push('### Level-by-level ④a vs ④b');
    lines.push('');
    lines.push('| level | ④a (claude -p) | ④b (openrouter) | gap |');
    lines.push('|-------|---------------|-----------------|-----|');
    for (const l of levels) {
      const a = cA.filter((r) => r.level === l);
      const b = cB.filter((r) => r.level === l);
      if (!a.length && !b.length) continue;
      const pa = a.length ? pct(a.filter(r => r.passed).length, a.length) : '-';
      const pb = b.length ? pct(b.filter(r => r.passed).length, b.length) : '-';
      const ga = a.length && b.length
        ? `${Math.round((a.filter(r => r.passed).length / a.length - b.filter(r => r.passed).length / b.length) * 100)}pp`
        : '-';
      lines.push(`| ${l} | ${pa} | ${pb} | ${ga} |`);
    }
    lines.push('');
  } else {
    lines.push('(④ data incomplete — run both claude-sonnet conditions)');
    lines.push('');
  }

  // Failure mode breakdown
  lines.push('## Failure Mode Breakdown');
  lines.push('');
  lines.push('| condition | pass | no-tool | explore-no-edit | wrong-edit | api-err |');
  lines.push('|-----------|------|---------|-----------------|------------|---------|');
  for (const cond of conditions) {
    const rs = results.filter((r) => r.conditionId === cond.id);
    const c = (cls: string) => rs.filter((r) => r.failClass === cls).length;
    lines.push(
      `| ${cond.label} | ${c('pass')} | ${c('no-tool-call')} | ${c('explore-no-edit')} | ${c('wrong-edit')} | ${c('api-error')} |`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

function parseArgs(argv: string[]) {
  const conditionIds: string[] = [];
  const taskIds: string[] = [];
  let repeat = 1;
  let timeoutSec = 300;
  let nudge = 3;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--conditions') conditionIds.push(...argv[++i].split(',').map((s) => s.trim()));
    else if (a === '--task') taskIds.push(argv[++i]);
    else if (a === '--repeat') repeat = Number(argv[++i]);
    else if (a === '--timeout') timeoutSec = Number(argv[++i]);
    else if (a === '--no-nudge') nudge = 0;
  }
  return {
    conditions: conditionIds.length
      ? ALL_CONDITIONS.filter((c) => conditionIds.includes(c.id))
      : ALL_CONDITIONS,
    tasks: taskIds.length
      ? CODING_TASKS.filter((t) => taskIds.includes(t.id))
      : CODING_TASKS,
    repeat,
    timeoutMs: timeoutSec * 1000,
    nudge,
  };
}

async function main() {
  loadEnvFile();
  initLocale('en');

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('[phase0] OPENROUTER_API_KEY not set');
    process.exit(1);
  }

  const { conditions, tasks, repeat, timeoutMs, nudge } = parseArgs(process.argv.slice(2));
  console.log(`[phase0] conditions=${conditions.length} tasks=${tasks.length} repeat=${repeat} timeout=${timeoutMs / 1000}s`);
  console.log(`[phase0] conditions: ${conditions.map((c) => c.id).join(', ')}`);
  console.log(`[phase0] total runs = ${conditions.length * tasks.length * repeat}`);

  const results: RunResult[] = [];

  // Sequential execution to avoid rate-limit conflicts between conditions
  for (const cond of conditions) {
    console.log(`\n[phase0] ── condition: ${cond.label} ──`);
    for (const task of tasks) {
      for (let rep = 1; rep <= repeat; rep++) {
        const r = await runOne(cond, task, rep, timeoutMs, nudge);
        results.push(r);
        const mark = r.passed ? '✅' : '❌';
        console.log(
          `  ${mark} ${cond.id.padEnd(22)} ${task.id.padEnd(28)} r${rep}  ` +
          `${r.toolCalls}tc/${r.editCalls}ed ${(r.durationMs / 1000).toFixed(0)}s  [${r.failClass}]  ${r.reason.slice(0, 60)}`,
        );
      }
    }
  }

  const outDir = join(dirname(new URL(import.meta.url).pathname), 'results');
  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });

  const jsonPath = join(outDir, 'phase0_gonogo.json');
  await writeFile(jsonPath, JSON.stringify({ conditions: conditions.map((c) => c.id), results }, null, 2));

  const report = buildReport(results, conditions);
  const mdPath = join(outDir, 'phase0_gonogo_report.md');
  await writeFile(mdPath, report);

  console.log('\n' + report);
  console.log(`[phase0] results → ${jsonPath}`);
  console.log(`[phase0] report  → ${mdPath}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
