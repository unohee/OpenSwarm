#!/usr/bin/env tsx
// ============================================
// OpenSwarm - Worker Fan-out Gate Benchmark
// ============================================
//
// Deterministic calibration set for the adaptive worker fan-out gate. This does
// not call models; it answers: "which representative tasks would fan-out execute
// for at a given threshold?"

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateWorkerFanoutGate } from '../src/agents/workerFanoutGate.js';
import type { TaskItem } from '../src/orchestration/decisionEngine.js';
import type { PipelineConfig } from '../src/agents/pairPipeline.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = join(ROOT, 'benchmarks', 'results');

interface GateCase {
  id: string;
  expected: 'single' | 'fanout';
  task: TaskItem;
  draftAnalysis?: PipelineConfig['draftAnalysis'];
  iteration?: number;
  feedbackSource?: 'objective' | 'review';
  effort?: 'low' | 'medium' | 'high';
}

function task(id: string, title: string, overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id,
    source: 'local',
    title,
    priority: 3,
    createdAt: Date.now(),
    ...overrides,
  };
}

const CASES: GateCase[] = [
  {
    id: 'small-doc',
    expected: 'single',
    task: task('small-doc', 'Update README wording', { estimatedMinutes: 5, fileScope: ['README.md'] }),
  },
  {
    id: 'small-leaf-bug',
    expected: 'single',
    task: task('small-leaf-bug', 'Fix typo in locale formatter', { estimatedMinutes: 10, fileScope: ['src/locale/en.ts'] }),
  },
  {
    id: 'broad-ui',
    expected: 'single',
    task: task('broad-ui', 'Polish dashboard empty states', {
      estimatedMinutes: 20,
      fileScope: ['src/support/dashboardHtml.ts', 'src/support/web.ts', 'src/locale/en.ts', 'src/locale/ko.ts'],
    }),
  },
  {
    id: 'pipeline-core',
    expected: 'fanout',
    task: task('pipeline-core', 'Add adaptive fan-out gate to PairPipeline', {
      estimatedMinutes: 45,
      fileScope: ['src/agents/pairPipeline.ts', 'src/agents/worker.ts'],
    }),
  },
  {
    id: 'worktree-core',
    expected: 'fanout',
    task: task('worktree-core', 'Harden worktree cleanup and PR publishing', {
      estimatedMinutes: 35,
      fileScope: ['src/support/worktreeManager.ts'],
    }),
  },
  {
    id: 'insufficient-draft-large',
    expected: 'fanout',
    task: task('insufficient-draft-large', 'Implement provider routing fallback', {
      estimatedMinutes: 30,
      fileScope: ['src/adapters/codexResponses.ts', 'src/adapters/gpt.ts'],
    }),
    draftAnalysis: {
      taskType: 'feature',
      intentSummary: 'Provider routing fallback',
      relevantFiles: ['src/adapters/codexResponses.ts', 'src/adapters/gpt.ts'],
      suggestedApproach: 'Investigate adapter fallbacks.',
      completionCriteria: ['Fallback is verified.'],
      sufficient: false,
    },
  },
  {
    id: 'review-retry',
    expected: 'fanout',
    task: task('review-retry', 'Revise reviewer-requested worker fix', { estimatedMinutes: 15 }),
    iteration: 2,
    feedbackSource: 'review',
  },
  {
    id: 'objective-retry',
    expected: 'fanout',
    task: task('objective-retry', 'Fix test failure from previous worker attempt', { estimatedMinutes: 15 }),
    iteration: 2,
    feedbackSource: 'objective',
  },
  {
    id: 'high-effort-small',
    expected: 'single',
    task: task('high-effort-small', 'Check a tricky but tiny config parser edge case', {
      estimatedMinutes: 10,
      fileScope: ['src/core/config.ts'],
    }),
    effort: 'high',
  },
  {
    id: 'urgent-nontrivial',
    expected: 'fanout',
    task: task('urgent-nontrivial', 'Urgently fix scheduler stuck loop', {
      priority: 1,
      estimatedMinutes: 20,
      fileScope: ['src/automation/autonomousRunner.ts', 'src/support/stuckDetector.ts'],
    }),
  },
];

function run(threshold: number) {
  return CASES.map((item) => {
    const decision = evaluateWorkerFanoutGate({
      task: item.task,
      draftAnalysis: item.draftAnalysis,
      iteration: item.iteration ?? 1,
      feedbackSource: item.feedbackSource,
      effort: item.effort,
      config: { minScore: threshold },
    });
    const actual = decision.shouldFanOut ? 'fanout' : 'single';
    return {
      id: item.id,
      expected: item.expected,
      actual,
      passed: actual === item.expected,
      score: decision.score,
      threshold: decision.threshold,
      signals: decision.signals.map((signal) => signal.code),
    };
  });
}

async function main(): Promise<void> {
  const thresholds = [1, 2, 3];
  const byThreshold = thresholds.map((threshold) => {
    const rows = run(threshold);
    return {
      threshold,
      pass: rows.filter((row) => row.passed).length,
      total: rows.length,
      fanoutCount: rows.filter((row) => row.actual === 'fanout').length,
      rows,
    };
  });

  for (const result of byThreshold) {
    console.log(`threshold=${result.threshold} pass=${result.pass}/${result.total} fanout=${result.fanoutCount}/${result.total}`);
  }

  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z');
  const payload = {
    createdAt: new Date().toISOString(),
    cases: CASES.map((item) => ({ id: item.id, expected: item.expected, title: item.task.title })),
    byThreshold,
  };
  const out = join(RESULTS_DIR, `workerFanoutGate-${stamp}.json`);
  await writeFile(out, JSON.stringify(payload, null, 2), 'utf8');
  await writeFile(join(RESULTS_DIR, 'workerFanoutGate-latest.json'), JSON.stringify(payload, null, 2), 'utf8');
  console.log(`results -> ${relative(ROOT, out)}`);
  console.log(`latest -> ${relative(ROOT, join(RESULTS_DIR, 'workerFanoutGate-latest.json'))}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
