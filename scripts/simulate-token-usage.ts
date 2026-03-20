#!/usr/bin/env npx tsx
// ============================================
// OpenSwarm Token Usage Simulator
// 두 모드(Normal / Turbo)의 일일 토큰 소모량 예측
// ============================================

// 모델별 토큰 비용 (per 1M tokens, USD)
const PRICING = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00 },
  'claude-opus-4-6': { input: 15.00, output: 75.00 },
} as const;

// 파이프라인 스테이지별 평균 토큰 추정치
const STAGE_TOKENS = {
  worker: { input: 15000, output: 8000 },    // 코드 생성 (프롬프트 + 컨텍스트)
  reviewer: { input: 12000, output: 3000 },   // 코드 리뷰 (diff + 판단)
  tester: { input: 10000, output: 5000 },     // 테스트 실행 + 결과
  auditor: { input: 8000, output: 2000 },     // 품질 감사
  documenter: { input: 8000, output: 3000 },  // 문서 생성
};

// 실패 시 추가 iteration 비용
const AVG_ITERATIONS = {
  normal: 1.5,  // 평균 1.5회 (50% 확률로 1회 retry)
  turbo: 1.5,
};

// Linear API 호출 비용 (API call당 예상 토큰 환산)
const LINEAR_API = {
  fetchPerHeartbeat: 1,     // getMyIssues
  mutationsPerTask: 8,      // updateState + comments + PR
  tokenPerApiCall: 500,     // GraphQL 요청+응답 평균 토큰
};

interface ModeConfig {
  name: string;
  heartbeatIntervalMin: number;
  dailyCap: number;
  avgTasksPerDay: number;
  skipTester: boolean;     // 코드 미변경 시 스킵 비율
  skipAuditor: boolean;    // 3파일 미만 스킵 비율
  reviewerReducedTurns: boolean;
  workerModel: string;
  reviewerModel: string;
}

const NORMAL: ModeConfig = {
  name: 'Normal',
  heartbeatIntervalMin: 30,
  dailyCap: 6,
  avgTasksPerDay: 4,
  skipTester: true,        // ~40% 스킵
  skipAuditor: true,       // ~50% 스킵
  reviewerReducedTurns: true,
  workerModel: 'claude-haiku-4-5-20251001',
  reviewerModel: 'claude-haiku-4-5-20251001',
};

const TURBO: ModeConfig = {
  name: 'Turbo',
  heartbeatIntervalMin: 5,
  dailyCap: 20,
  avgTasksPerDay: 12,
  skipTester: false,
  skipAuditor: false,
  reviewerReducedTurns: false,
  workerModel: 'claude-haiku-4-5-20251001',
  reviewerModel: 'claude-haiku-4-5-20251001',
};

// OLD: 5초 heartbeat, 무제한 (이전 설정)
const OLD: ModeConfig = {
  name: 'Old (5s, unlimited)',
  heartbeatIntervalMin: 0.083, // 5 seconds
  dailyCap: 999,
  avgTasksPerDay: 30,
  skipTester: false,
  skipAuditor: false,
  reviewerReducedTurns: false,
  workerModel: 'claude-sonnet-4-5-20250929',
  reviewerModel: 'claude-sonnet-4-5-20250929',
};

function getPrice(model: string): { input: number; output: number } {
  return (PRICING as Record<string, { input: number; output: number }>)[model]
    ?? PRICING['claude-haiku-4-5-20251001'];
}

function simulate(mode: ModeConfig) {
  const workerPrice = getPrice(mode.workerModel);
  const reviewerPrice = getPrice(mode.reviewerModel);

  // 작업 시간 (8시간 = 시간 윈도우 기반)
  const workHours = 8;
  const heartbeatsPerDay = Math.floor((workHours * 60) / mode.heartbeatIntervalMin);
  const tasks = Math.min(mode.avgTasksPerDay, mode.dailyCap);

  // 파이프라인 토큰
  const iterations = AVG_ITERATIONS.normal;
  const testerSkipRate = mode.skipTester ? 0.4 : 0;
  const auditorSkipRate = mode.skipAuditor ? 0.5 : 0;
  const reviewerTurnMultiplier = mode.reviewerReducedTurns ? 0.7 : 1.0; // 30% 감소

  let totalInput = 0;
  let totalOutput = 0;
  let totalCostUsd = 0;

  // Per-task cost
  for (let i = 0; i < tasks; i++) {
    // Worker (per iteration)
    const workerInput = STAGE_TOKENS.worker.input * iterations;
    const workerOutput = STAGE_TOKENS.worker.output * iterations;
    totalInput += workerInput;
    totalOutput += workerOutput;
    totalCostUsd += (workerInput / 1_000_000) * workerPrice.input;
    totalCostUsd += (workerOutput / 1_000_000) * workerPrice.output;

    // Reviewer
    const revInput = STAGE_TOKENS.reviewer.input * iterations * reviewerTurnMultiplier;
    const revOutput = STAGE_TOKENS.reviewer.output * iterations * reviewerTurnMultiplier;
    totalInput += revInput;
    totalOutput += revOutput;
    totalCostUsd += (revInput / 1_000_000) * reviewerPrice.input;
    totalCostUsd += (revOutput / 1_000_000) * reviewerPrice.output;

    // Tester (conditional)
    if (Math.random() > testerSkipRate) {
      totalInput += STAGE_TOKENS.tester.input;
      totalOutput += STAGE_TOKENS.tester.output;
      totalCostUsd += (STAGE_TOKENS.tester.input / 1_000_000) * workerPrice.input;
      totalCostUsd += (STAGE_TOKENS.tester.output / 1_000_000) * workerPrice.output;
    }

    // Auditor (conditional)
    if (Math.random() > auditorSkipRate) {
      totalInput += STAGE_TOKENS.auditor.input;
      totalOutput += STAGE_TOKENS.auditor.output;
      totalCostUsd += (STAGE_TOKENS.auditor.input / 1_000_000) * workerPrice.input;
      totalCostUsd += (STAGE_TOKENS.auditor.output / 1_000_000) * workerPrice.output;
    }
  }

  // Linear API overhead
  const linearCalls = heartbeatsPerDay * LINEAR_API.fetchPerHeartbeat
    + tasks * LINEAR_API.mutationsPerTask;
  const linearTokens = linearCalls * LINEAR_API.tokenPerApiCall;
  totalInput += linearTokens;

  return {
    mode: mode.name,
    heartbeatsPerDay,
    tasksPerDay: tasks,
    totalInputTokens: Math.round(totalInput),
    totalOutputTokens: Math.round(totalOutput),
    totalTokens: Math.round(totalInput + totalOutput),
    estimatedCostUsd: totalCostUsd,
    linearApiCalls: linearCalls,
    linearApiPerHour: Math.round(linearCalls / workHours),
    workerModel: mode.workerModel.replace('claude-', '').replace('-20250929', '').replace('-20251001', ''),
  };
}

// Run simulations
console.log('='.repeat(70));
console.log('  OpenSwarm Token Usage Simulation');
console.log('  Work window: 8 hours/day');
console.log('='.repeat(70));
console.log('');

const results = [OLD, NORMAL, TURBO].map(simulate);

// Table header
console.log(
  'Mode'.padEnd(25),
  'Tasks'.padStart(6),
  'Tokens'.padStart(12),
  'Cost/day'.padStart(10),
  'Cost/mo'.padStart(10),
  'Linear/h'.padStart(10),
  'Model'.padStart(15),
);
console.log('-'.repeat(90));

for (const r of results) {
  const tokens = r.totalTokens > 1_000_000
    ? (r.totalTokens / 1_000_000).toFixed(1) + 'M'
    : (r.totalTokens / 1_000).toFixed(0) + 'K';
  const costDay = '$' + r.estimatedCostUsd.toFixed(2);
  const costMonth = '$' + (r.estimatedCostUsd * 30).toFixed(2);

  console.log(
    r.mode.padEnd(25),
    String(r.tasksPerDay).padStart(6),
    tokens.padStart(12),
    costDay.padStart(10),
    costMonth.padStart(10),
    String(r.linearApiPerHour).padStart(10),
    r.workerModel.padStart(15),
  );
}

console.log('');
console.log('--- Savings ---');
const oldResult = results[0];
const normalResult = results[1];
const turboResult = results[2];

const savingsNormal = ((1 - normalResult.estimatedCostUsd / oldResult.estimatedCostUsd) * 100).toFixed(0);
const savingsTurbo = ((1 - turboResult.estimatedCostUsd / oldResult.estimatedCostUsd) * 100).toFixed(0);

console.log(`Normal vs Old:  ${savingsNormal}% cost reduction, ${((1 - normalResult.totalTokens / oldResult.totalTokens) * 100).toFixed(0)}% token reduction`);
console.log(`Turbo vs Old:   ${savingsTurbo}% cost reduction, ${((1 - turboResult.totalTokens / oldResult.totalTokens) * 100).toFixed(0)}% token reduction`);
console.log(`Normal Linear API: ${normalResult.linearApiPerHour}/hour (limit: 5000/hour)`);
console.log(`Turbo Linear API:  ${turboResult.linearApiPerHour}/hour (limit: 5000/hour)`);
console.log(`Old Linear API:    ${oldResult.linearApiPerHour}/hour (limit: 5000/hour) ← EXCEEDED`);
console.log('');
console.log('Note: These are estimates based on average pipeline token usage.');
console.log('Actual costs depend on task complexity, model selection, and retry rates.');
