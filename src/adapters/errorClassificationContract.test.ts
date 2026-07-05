import { describe, it, expect } from 'vitest';
import { detectRateLimit } from './rateLimitError.js';
import { isInfraError } from './errorClassification.js';

// ============================================================================
// The exception-classification CONTRACT (INT-2521 capstone).
//
// Every error the daemon can hit must land in EXACTLY ONE of three buckets, in
// this precedence (the pipeline's own order — RateLimitError first, then infra,
// else a real task failure):
//   rate_limited  → scheduler pause, NOT counted toward STUCK
//   infra_error   → backoff retry,   NOT counted toward STUCK
//   task_failure  → a real verdict,  counted toward STUCK
//
// The whole INT-2521 effort exists so that NOTHING slips: a rate/usage limit or an
// infra hiccup must never masquerade as a task_failure (→ false STUCK) or a
// success, and a genuine bad edit must still count. This table is the single
// regression guard for that contract — a change that mis-buckets any row here is a
// re-introduction of the exact class of bug this epic closed.
// ============================================================================

type Bucket = 'rate_limited' | 'infra_error' | 'task_failure';

// Classify a raw error message in the SAME PRECEDENCE the pipeline applies —
// rate-limit wins over infra wins over task. The pipeline reaches rate_limited via
// `instanceof RateLimitError` (the typed throw); this matrix exercises the
// string-detection twin (`detectRateLimit`) that reclassifies a message when only
// text survives (a caught/re-serialized error, stuckDetector's error-loop text).
// Both must agree on which bucket a given signal belongs to — that agreement is
// the contract under test.
function classify(err: string | Error): Bucket {
  if (detectRateLimit(typeof err === 'string' ? err : err.message, '')) return 'rate_limited';
  if (isInfraError(err)) return 'infra_error';
  return 'task_failure';
}

const CASES: Array<{ name: string; err: string | Error; bucket: Bucket }> = [
  // ---- rate / usage limits (every provider) ----
  { name: 'codex-responses 300min window', err: 'API error: Codex 100% used of 300min window — resets at 2026-06-30T12:00:00Z', bucket: 'rate_limited' },
  { name: 'codex CLI usage limit', err: "You've hit your usage limit. Visit … to purchase more credits", bucket: 'rate_limited' },
  { name: 'claude session limit (out_of_credits)', err: '{"type":"rate_limit_event","rate_limit_info":{"overageDisabledReason":"out_of_credits"}}', bucket: 'rate_limited' },
  { name: 'OpenAI 429 rate_limit_exceeded', err: '{"error":{"code":"rate_limit_exceeded"}}', bucket: 'rate_limited' },
  { name: 'OpenAI insufficient_quota', err: '{"error":{"type":"insufficient_quota"}}', bucket: 'rate_limited' },
  { name: 'OpenRouter 402 insufficient credits', err: 'OpenRouter API error (402): Insufficient credits. Add more to continue.', bucket: 'rate_limited' },
  { name: 'local 429 too many requests', err: 'Local API error (429): Too Many Requests', bucket: 'rate_limited' },

  // ---- infra / capacity (reviewer/scheduler must retry, NOT STUCK) ----
  { name: 'CLI non-zero exit', err: 'codex CLI failed with code 1: (empty)', bucket: 'infra_error' },
  { name: 'stage/git timeout', err: 'codex timeout after 300000ms', bucket: 'infra_error' },
  { name: 'connection refused', err: 'connect ECONNREFUSED 127.0.0.1:1234', bucket: 'infra_error' },
  { name: 'undici fetch failed (cause.code)', err: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), bucket: 'infra_error' },
  { name: 'server 503 (adapter wrapper)', err: 'Local API error (503): model is loading', bucket: 'infra_error' },
  { name: 'auth 401', err: 'Request failed: 401 Unauthorized', bucket: 'infra_error' },
  { name: 'git-tracker snapshot/diff failure', err: 'git-tracker: diff since snapshot failed: fatal: bad object', bucket: 'infra_error' },
  { name: 'reviewer parse crash', err: 'reviewer-stage: produced no parseable verdict: TypeError x', bucket: 'infra_error' },
  { name: 'scheduler hard watchdog', err: 'Task timed out after 3600000ms (scheduler hard watchdog)', bucket: 'infra_error' },

  // ---- genuine task failures (MUST count toward STUCK) ----
  { name: 'code TypeError', err: 'TypeError: cannot read property foo of undefined', bucket: 'task_failure' },
  { name: 'test assertion', err: 'Test failed: expected 3 to equal 4', bucket: 'task_failure' },
  { name: 'edit did not apply', err: 'old_string not found in file', bucket: 'task_failure' },
  { name: 'reviewer quality reject', err: 'Reviewer rejected: missing null check', bucket: 'task_failure' },
  // prose that merely MENTIONS the trigger words is a task failure, not mis-bucketed
  { name: 'prose: usage/credits/limit words', err: 'Implemented a usage dashboard; the plan limit is configurable and credits reset each window.', bucket: 'task_failure' },
  { name: 'prose: bare status numbers', err: 'assertion failed: expected 503 rows at line 401', bucket: 'task_failure' },
];

describe('exception-classification contract (INT-2521)', () => {
  for (const c of CASES) {
    it(`${c.bucket.padEnd(12)} ← ${c.name}`, () => {
      expect(classify(c.err)).toBe(c.bucket);
    });
  }

  it('the three buckets are exhaustive and mutually exclusive over the table', () => {
    const counts = { rate_limited: 0, infra_error: 0, task_failure: 0 };
    for (const c of CASES) counts[classify(c.err)] += 1;
    // Every row landed somewhere; each bucket has real coverage.
    expect(counts.rate_limited + counts.infra_error + counts.task_failure).toBe(CASES.length);
    expect(counts.rate_limited).toBeGreaterThan(0);
    expect(counts.infra_error).toBeGreaterThan(0);
    expect(counts.task_failure).toBeGreaterThan(0);
  });
});
