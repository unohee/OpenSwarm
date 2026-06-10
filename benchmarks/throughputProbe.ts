#!/usr/bin/env tsx
// Created: 2026-06-09
// Purpose: ZDR(data_collection:deny) 조건에서 후보 모델의 provider/throughput 변동 측정.
//          실제 운영(provider 자동선택)과 동일 조건. tok/s + provider 분포 + TTFT.
// Dependencies: tsx, OPENROUTER_API
// Test Status: profiling
//
// 실행: source ~/dev/VEGA/.env && npx tsx benchmarks/throughputProbe.ts

const API = 'https://openrouter.ai/api/v1/chat/completions';
const PROMPT =
  'Write a TypeScript function validateEmail(s) using a regex, with a null/empty guard ' +
  'and JSDoc, then 3 unit test cases. Output code only.';

const MODELS = [
  'z-ai/glm-4.7-flash',
  'qwen/qwen3-coder-30b-a3b-instruct',
  'deepseek/deepseek-v4-flash',
  'google/gemini-2.5-flash',
];
const SAMPLES = 4;

interface Sample { provider: string; tokens: number; sec: number; tps: number; err?: string }

async function probe(apiKey: string, model: string): Promise<Sample> {
  const t0 = Date.now();
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: PROMPT }],
        max_tokens: 700,
        provider: { data_collection: 'deny' }, // ZDR 유지 조건
      }),
    });
    const sec = (Date.now() - t0) / 1000;
    const d = await res.json() as {
      provider?: string;
      usage?: { completion_tokens?: number };
      error?: { message?: string };
    };
    if (d.error) return { provider: '-', tokens: 0, sec, tps: 0, err: d.error.message?.slice(0, 50) };
    const tokens = d.usage?.completion_tokens ?? 0;
    return { provider: d.provider ?? '?', tokens, sec, tps: sec > 0 ? tokens / sec : 0 };
  } catch (e) {
    return { provider: '-', tokens: 0, sec: (Date.now() - t0) / 1000, tps: 0, err: String(e).slice(0, 50) };
  }
}

async function main() {
  const apiKey = process.env.OPENROUTER_API;
  if (!apiKey) { console.error('OPENROUTER_API not set'); process.exit(1); }

  for (const model of MODELS) {
    console.log(`\n=== ${model} (ZDR, ${SAMPLES} samples) ===`);
    const samples: Sample[] = [];
    // 직렬 — 같은 모델 동시호출은 provider 큐를 왜곡
    for (let i = 0; i < SAMPLES; i++) {
      const s = await probe(apiKey, model);
      samples.push(s);
      if (s.err) console.log(`  sample${i + 1}: ERR ${s.err}`);
      else console.log(`  sample${i + 1}: ${s.provider.padEnd(14)} ${String(s.tokens).padStart(4)}tok ${s.sec.toFixed(1)}s ${s.tps.toFixed(1)} tok/s`);
    }
    const ok = samples.filter(s => !s.err && s.tokens > 0);
    if (ok.length) {
      const avgTps = ok.reduce((a, s) => a + s.tps, 0) / ok.length;
      const avgSec = ok.reduce((a, s) => a + s.sec, 0) / ok.length;
      const provs = [...new Set(ok.map(s => s.provider))].join(', ');
      console.log(`  → avg ${avgTps.toFixed(1)} tok/s, ${avgSec.toFixed(1)}s | providers: ${provs}`);
    }
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
