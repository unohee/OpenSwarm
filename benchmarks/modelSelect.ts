#!/usr/bin/env tsx
// ============================================
// OpenSwarm - Model Selection Benchmark
// Created: 2026-06-09
// Purpose: 코딩 태스크에 대해 worker 모델별 품질·비용을 측정해 파레토 경계를 찾는다.
//          VEGA benchmarks/model_select.py 이식: 점수 = pass_rate → 실비용 → turn 수.
//          자동 교체 안 함 — 랭킹만 출력, 사람이 config 반영(통제력 유지).
//
// 실행:
//   source ~/dev/VEGA/.env   (OPENROUTER_API 필요)
//   npx tsx benchmarks/modelSelect.ts --repeat 3
//   npx tsx benchmarks/modelSelect.ts --model openai/gpt-5 --model qwen/qwen3-coder
//   npx tsx benchmarks/modelSelect.ts --task L0-fix-multiply --repeat 5
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
import { CODING_TASKS, type BenchTask } from './tasks/codingTasks.js';

const exec = promisify(execFile);

// ---- 후보 모델 풀 ----
// non-frontier 오픈 모델 중심 (gpt 계열은 별도 측정에서 비교됨).
// baseline = gemini-2.5-flash (직전 라운드 100% pass 우승자).
const DEFAULT_CANDIDATES = [
  'google/gemini-2.5-flash',          // baseline (직전 우승)
  'deepseek/deepseek-v4-pro',         // deepseek 플래그십
  'deepseek/deepseek-v4-flash',       // deepseek 경량
  'minimax/minimax-m3',               // MiniMax 최신
  'z-ai/glm-5',                       // GLM 최신
  'z-ai/glm-4.7-flash',               // GLM 초저가
  'moonshotai/kimi-k2-thinking',      // Kimi 코딩 강자
  'qwen/qwen3-coder-30b-a3b-instruct',// qwen 코딩 경량
];

interface RunResult {
  model: string;
  taskId: string;
  rep: number;
  passed: boolean;
  reason: string;
  toolCalls: number;
  apiCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  durationMs: number;
}

interface ModelAgg {
  model: string;
  runs: number;
  passes: number;
  passRate: number;
  avgCostUsd: number;
  costPerPass: number;       // 성공당 비용 (핵심 효율 지표)
  avgToolCalls: number;
  avgDurationMs: number;
}

// ---- OpenRouter 가격 카탈로그 ----
async function fetchPrices(apiKey: string): Promise<Map<string, { in: number; out: number }>> {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = (await res.json()) as { data: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }> };
  const map = new Map<string, { in: number; out: number }>();
  for (const m of data.data) {
    map.set(m.id, {
      in: parseFloat(m.pricing?.prompt ?? '0'),
      out: parseFloat(m.pricing?.completion ?? '0'),
    });
  }
  return map;
}

async function setupRepo(task: BenchTask): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'osw-bench-'));
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
  task: BenchTask,
  model: string,
  rep: number,
  prices: Map<string, { in: number; out: number }>,
): Promise<RunResult> {
  const dir = await setupRepo(task);
  const logs: string[] = [];
  const t0 = Date.now();

  try {
    await runWorker({
      taskTitle: task.title,
      taskDescription: task.description,
      projectPath: dir,
      adapterName: 'openrouter',
      model,
      timeoutMs: 240_000,
      maxTurns: 20,
      onLog: (l) => logs.push(l),
    });
  } catch (err) {
    logs.push(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  }

  const durationMs = Date.now() - t0;

  // 채점: repo 상태를 read 함수로 넘김
  const read = (rel: string): string | null => {
    try {
      return readFileSync(join(dir, rel), 'utf-8');
    } catch {
      return null;
    }
  };
  const verdict = task.check(read, dir);

  // 로그에서 메트릭 추출
  const toolCalls = logs.filter((l) => l.includes('🔧')).length;
  const apiCalls = logs.filter((l) => l.includes('API call #')).length;
  const tokenLine = logs.find((l) => /\d+ tokens/.test(l)) ?? '';
  const totalTokens = Number(tokenLine.match(/(\d+) tokens/)?.[1] ?? 0);
  // prompt/completion 분리는 어댑터가 합산만 주므로 근사: 입력 80% / 출력 20% 가정.
  // (정밀 측정이 필요하면 어댑터가 usage 분리 반환하도록 확장)
  const promptTokens = Math.round(totalTokens * 0.8);
  const completionTokens = totalTokens - promptTokens;

  const price = prices.get(model) ?? { in: 0, out: 0 };
  const costUsd = promptTokens * price.in + completionTokens * price.out;

  await rm(dir, { recursive: true, force: true });

  return {
    model, taskId: task.id, rep,
    passed: verdict.passed, reason: verdict.reason,
    toolCalls, apiCalls, promptTokens, completionTokens, costUsd, durationMs,
  };
}

function aggregate(results: RunResult[]): ModelAgg[] {
  const byModel = new Map<string, RunResult[]>();
  for (const r of results) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model)!.push(r);
  }

  const aggs: ModelAgg[] = [];
  for (const [model, rs] of byModel) {
    const passes = rs.filter((r) => r.passed).length;
    const passRate = passes / rs.length;
    const avgCostUsd = rs.reduce((s, r) => s + r.costUsd, 0) / rs.length;
    const totalCost = rs.reduce((s, r) => s + r.costUsd, 0);
    aggs.push({
      model,
      runs: rs.length,
      passes,
      passRate,
      avgCostUsd,
      costPerPass: passes > 0 ? totalCost / passes : Infinity,
      avgToolCalls: rs.reduce((s, r) => s + r.toolCalls, 0) / rs.length,
      avgDurationMs: rs.reduce((s, r) => s + r.durationMs, 0) / rs.length,
    });
  }

  // VEGA 랭킹: pass_rate 내림차순 → costPerPass 오름차순 → toolCalls 오름차순
  aggs.sort((a, b) =>
    b.passRate - a.passRate ||
    a.costPerPass - b.costPerPass ||
    a.avgToolCalls - b.avgToolCalls);
  return aggs;
}

function fmtUsd(n: number): string {
  if (!isFinite(n)) return '∞';
  if (n < 0.001) return `$${(n * 1000).toFixed(3)}m`; // milli-dollar
  return `$${n.toFixed(4)}`;
}

/** taskId → level 매핑 (RUBRIC.md의 난이도 사다리) */
function levelOf(taskId: string): string {
  const m = taskId.match(/^(L\d)/);
  return m ? m[1] : '?';
}

/**
 * 모델 × 레벨 pass-rate 표. RUBRIC.md의 핵심 — "어느 난이도에서 모델이 갈리는가".
 * 경량 모델은 보통 L0~L4를 통과하다 L5~L6에서 무너진다(변별 지점).
 */
function levelTable(results: RunResult[]): string {
  const levels = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
  const models = [...new Set(results.map((r) => r.model))];
  const cell = new Map<string, { p: number; n: number }>();
  for (const r of results) {
    const k = `${r.model}|${levelOf(r.taskId)}`;
    const c = cell.get(k) ?? { p: 0, n: 0 };
    c.n++; if (r.passed) c.p++;
    cell.set(k, c);
  }
  const lines: string[] = [];
  lines.push('\n========== LEVEL × MODEL pass-rate (RUBRIC discrimination) ==========');
  lines.push(`${'model'.padEnd(34)} ${levels.map((l) => l.padStart(5)).join(' ')}`);
  for (const model of models) {
    const cells = levels.map((l) => {
      const c = cell.get(`${model}|${l}`);
      return c && c.n ? `${Math.round((c.p / c.n) * 100)}%`.padStart(5) : '  -  ';
    });
    lines.push(`${model.padEnd(34)} ${cells.join(' ')}`);
  }
  lines.push('(L6 = 실전 SWE-bench, 별도 채점 — benchmarks/sweBench.ts + RUBRIC.md)');
  return lines.join('\n');
}

function report(aggs: ModelAgg[], baseline: string, results: RunResult[]): string {
  const lines: string[] = [];
  lines.push(levelTable(results));
  lines.push('\n========== MODEL RANKING (pass_rate → $/pass → tool calls) ==========');
  lines.push('rank  model                       pass    $/pass     avg$     tools  dur');
  aggs.forEach((a, i) => {
    const tag = a.model === baseline ? ' (baseline)' : '';
    lines.push(
      `${String(i + 1).padEnd(4)}  ${a.model.padEnd(26)}  ` +
      `${(a.passRate * 100).toFixed(0).padStart(3)}%  ` +
      `${fmtUsd(a.costPerPass).padStart(8)}  ` +
      `${fmtUsd(a.avgCostUsd).padStart(8)}  ` +
      `${a.avgToolCalls.toFixed(1).padStart(5)}  ` +
      `${(a.avgDurationMs / 1000).toFixed(0)}s${tag}`,
    );
  });

  // 파레토 경계: baseline과 동일 pass_rate를 유지하는 가장 싼 모델
  const base = aggs.find((a) => a.model === baseline);
  if (base) {
    const asGoodCheaper = aggs.filter(
      (a) => a.model !== baseline && a.passRate >= base.passRate && a.costPerPass < base.costPerPass,
    );
    lines.push('\n========== PARETO FINDING ==========');
    lines.push(`baseline: ${baseline} — pass ${(base.passRate * 100).toFixed(0)}%, $/pass ${fmtUsd(base.costPerPass)}`);
    if (asGoodCheaper.length > 0) {
      const best = asGoodCheaper[0];
      const savings = ((1 - best.costPerPass / base.costPerPass) * 100).toFixed(0);
      lines.push(`✅ ${best.model} matches quality (${(best.passRate * 100).toFixed(0)}%) at ${savings}% lower $/pass`);
      lines.push(`   → safe to route here; keep ${baseline} as escalate target.`);
    } else {
      lines.push(`⚠️ No cheaper model matched ${baseline}'s pass rate. Keep frontier or add more repeats.`);
    }
  }
  return lines.join('\n');
}

// ---- CLI ----
function parseArgs(argv: string[]) {
  const models: string[] = [];
  const taskIds: string[] = [];
  let repeat = 3;
  let baseline = 'google/gemini-2.5-flash';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') models.push(argv[++i]);
    else if (argv[i] === '--task') taskIds.push(argv[++i]);
    else if (argv[i] === '--repeat') repeat = Number(argv[++i]);
    else if (argv[i] === '--baseline') baseline = argv[++i];
  }
  return {
    models: models.length ? models : DEFAULT_CANDIDATES,
    tasks: taskIds.length ? CODING_TASKS.filter((t) => taskIds.includes(t.id)) : CODING_TASKS,
    repeat, baseline,
  };
}

async function main() {
  initLocale('en');
  setDefaultAdapter('openrouter');

  const apiKey = process.env.OPENROUTER_API;
  if (!apiKey) {
    console.error('OPENROUTER_API not set. Run: source ~/dev/VEGA/.env');
    process.exit(1);
  }

  const { models, tasks, repeat, baseline } = parseArgs(process.argv.slice(2));
  console.log(`[bench] models=${models.length} tasks=${tasks.length} repeat=${repeat}`);
  console.log(`[bench] total runs = ${models.length * tasks.length * repeat}`);

  const prices = await fetchPrices(apiKey);

  // 모델별 병렬 실행 — 각 모델은 독립 임시 repo를 쓰므로 충돌 없음.
  // 한 모델 내에서는 태스크×반복을 직렬로 돌려 단일 모델의 rate limit을 피한다.
  // gpt-5 같은 느린 모델이 빠른 모델을 막지 않아 전체 wall-clock이 크게 준다.
  const perModel = await Promise.all(
    models.map(async (model) => {
      const out: RunResult[] = [];
      for (const task of tasks) {
        for (let rep = 1; rep <= repeat; rep++) {
          const r = await runOne(task, model, rep, prices);
          out.push(r);
          const mark = r.passed ? '✅' : '❌';
          console.log(`  ${mark} ${model.padEnd(24)} ${task.id.padEnd(24)} rep${rep}  ${fmtUsd(r.costUsd)} ${r.toolCalls}tc ${(r.durationMs / 1000).toFixed(0)}s  ${r.reason}`);
        }
      }
      return out;
    }),
  );
  const results: RunResult[] = perModel.flat();

  const aggs = aggregate(results);
  console.log(report(aggs, baseline, results));

  // 결과 저장 (타임스탬프는 인자로 안 받으므로 결과 파일명은 고정 — 덮어씀)
  const outDir = join(dirname(new URL(import.meta.url).pathname), 'results');
  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, 'latest.json');
  await writeFile(outPath, JSON.stringify({ results, aggs, baseline }, null, 2));
  console.log(`\n[bench] raw results → ${outPath}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
