// ============================================
// OpenSwarm - Multi-Lens Reviewer Fan-out (INT-2230)
// ============================================
//
// PoC: verify one worker result through several independent review "lenses" in
// parallel, then merge into a single ReviewResult. Each lens is just a focused
// prompt injected into `taskDescription` — no extra adapter/infra needed — so the
// existing reviewer agent runs N times, each told to concentrate on one concern
// (correctness / security / regression-risk). The merge takes the WORST decision
// and unions the issues/suggestions/recommendedActions so nothing a lens caught
// is dropped. Gated + opt-in (config.review.multiLens.enabled, default false) to
// avoid multiplying usage on every task.

import type { ReviewResult, ReviewDecision } from './agentPair.js';
import type { ReviewerOptions } from './reviewer.js';
import { runReviewer } from './reviewer.js';
import { runPool } from '../support/concurrencyPool.js';
import { RateLimitError } from '../adapters/rateLimitError.js';

// Lenses

/** A single review perspective. `focus` is injected verbatim into the prompt. */
export interface ReviewLens {
  key: string;
  focus: string;
}

/** The three default lenses a fan-out review runs in parallel. */
export const REVIEW_LENSES: ReviewLens[] = [
  {
    key: 'correctness',
    focus: 'logic errors, unhandled edge cases, off-by-one, wrong assumptions, error handling',
  },
  {
    key: 'security',
    focus: 'injection, unsafe input, leaked secrets/keys, auth gaps, unsafe deserialization',
  },
  {
    key: 'regression-risk',
    focus: 'breaks existing behavior, changes a shared contract, missing/!updated tests, side effects on callers',
  },
];

/**
 * Append a lens directive to the base task description so the reviewer
 * concentrates on one concern. Other concerns are explicitly delegated to the
 * sibling lenses so a single reviewer doesn't try to cover everything.
 */
export function buildLensTaskDescription(base: string, lens: ReviewLens): string {
  return `${base}\n\n## Review lens: ${lens.key}\nFocus your review specifically on: ${lens.focus}. Other concerns are secondary — another reviewer covers them.`;
}

// Merge

/** Severity ordering: reject is worst, approve is best. */
const DECISION_RANK: Record<ReviewDecision, number> = {
  approve: 0,
  revise: 1,
  reject: 2,
};

/** First non-empty line of a feedback blob, trimmed (one-line lens summary). */
function firstLine(text: string | undefined): string {
  if (!text) return '';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/** Stable dedup of strings by trimmed/lowercased value, keeping first original. */
function dedupStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * Combine several lens reviews into one verdict:
 * - decision = the WORST across lenses (reject > revise > approve)
 * - issues / suggestions / recommendedActions = deduped union
 * - feedback = one line per lens result, joined
 * Empty input yields a clean approve (nothing flagged).
 */
export function mergeReviewResults(results: ReviewResult[]): ReviewResult {
  if (results.length === 0) {
    return { decision: 'approve', feedback: '', issues: [], suggestions: [], recommendedActions: [] };
  }

  let decision: ReviewDecision = 'approve';
  for (const r of results) {
    if (DECISION_RANK[r.decision] > DECISION_RANK[decision]) decision = r.decision;
  }

  const issues = dedupStrings(results.flatMap((r) => r.issues ?? []));
  const suggestions = dedupStrings(results.flatMap((r) => r.suggestions ?? []));

  const actionSeen = new Set<string>();
  const recommendedActions: NonNullable<ReviewResult['recommendedActions']> = [];
  for (const action of results.flatMap((r) => r.recommendedActions ?? [])) {
    const key = `${action.type}|${action.location ?? ''}|${action.title}`;
    if (actionSeen.has(key)) continue;
    actionSeen.add(key);
    recommendedActions.push(action);
  }

  const feedback = results
    .map((r) => firstLine(r.feedback))
    .filter(Boolean)
    .join('\n');

  return { decision, feedback, issues, suggestions, recommendedActions };
}

// Gating

/**
 * Decide whether a task is worth the extra cost of multi-lens fan-out. Triggers
 * on a wide change surface, high priority (1=Urgent, 2=High), or an explicit
 * `deep-review` label. Threshold defaults to 3 changed files.
 */
export function shouldFanoutReview(
  task: { filesChanged?: string[]; priority?: number; labels?: string[] },
  opts?: { fileThreshold?: number },
): boolean {
  const fileThreshold = opts?.fileThreshold ?? 3;
  const fileCount = task.filesChanged?.length ?? 0;
  if (fileCount >= fileThreshold) return true;
  if (task.priority != null && task.priority <= 2) return true;
  return !!task.labels?.includes('deep-review');
}

// Fan-out

/**
 * Run every lens in parallel and merge. Each lens calls the reviewer with a
 * lens-scoped task description. A lens that fails for a non-rate-limit reason is
 * skipped (its slot carries an error from the pool). A RateLimitError from ANY
 * lens propagates so the pipeline's existing usage-limit handling / claude
 * fallback can take over (INT-2192) instead of silently dropping a lens.
 * `deps` is injectable for tests.
 */
export async function runMultiLensReview(
  options: ReviewerOptions,
  deps?: {
    review?: (o: ReviewerOptions) => Promise<ReviewResult>;
    concurrency?: number;
    lenses?: ReviewLens[];
  },
): Promise<ReviewResult> {
  const review = deps?.review ?? runReviewer;
  const lenses = deps?.lenses ?? REVIEW_LENSES;
  const concurrency = deps?.concurrency ?? lenses.length;

  const settled = await runPool(lenses, concurrency, async (lens) => {
    const result = await review({
      ...options,
      taskDescription: buildLensTaskDescription(options.taskDescription, lens),
    });
    // Tag the feedback with the lens so the merged summary reads "[correctness] …".
    return { ...result, feedback: `[${lens.key}] ${firstLine(result.feedback)}` };
  });

  // A rate limit on any lens means the quota is exhausted — propagate so the
  // pipeline pauses / falls back rather than merging a partial review.
  for (const s of settled) {
    if (s.error instanceof RateLimitError) throw s.error;
  }

  const ok = settled.filter((s): s is { index: number; value: ReviewResult } => s.value !== undefined).map((s) => s.value);
  return mergeReviewResults(ok);
}
