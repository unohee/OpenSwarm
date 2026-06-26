// ============================================
// OpenSwarm - Shared adapter result parsing
// ============================================
//
// Worker/Reviewer result extraction shared by the gpt, local, and openrouter
// adapters. These three adapters each ran a byte-for-byte copy of the same
// eight functions; the copies had already drifted in formatting and comment
// wording (a latent correctness risk if one copy were fixed and the others
// not). This module is the single source of truth — each adapter delegates to
// `parseWorkerResult` / `parseReviewerResult`.

import type { WorkerResult, ReviewResult } from './types.js';
import { t } from '../locale/index.js';

/** JSON-first worker parse: fenced ```json block, else a `"success"`-anchored object. */
function extractWorkerResultJson(text: string): WorkerResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch?.[1] ?? findJsonObject(text, '"success"');
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      success: Boolean(parsed.success),
      summary: parsed.summary || t('common.fallback.noSummary'),
      filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      output: text,
      error: parsed.error,
      confidencePercent:
        typeof parsed.confidencePercent === 'number' ? parsed.confidencePercent : undefined,
      haltReason: parsed.haltReason || undefined,
    };
  } catch {
    return null;
  }
}

/** Text fallback when no JSON result is present. */
function extractWorkerFromText(text: string): WorkerResult {
  // Only an explicit failure phrase marks the run as failed. Loose words like
  // "error" or "fail" appear in normal coding prose ("error handling", "the
  // failing test") and used to cause false negatives. git-diff promotion in
  // worker.ts is the real success signal; this is just the non-repo fallback.
  const failed = isExplicitFailure(text);

  return {
    success: !failed,
    summary: extractSummary(text),
    filesChanged: [],
    commands: [],
    output: text,
    error: failed ? extractErrorMessage(text) : undefined,
  };
}

/** JSON-first reviewer parse: fenced ```json block, else a `"decision"`-anchored object. */
function extractReviewerResultJson(text: string): ReviewResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch?.[1] ?? findJsonObject(text, '"decision"');
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr);
    const decision =
      parsed.decision === 'approve' || parsed.decision === 'reject' ? parsed.decision : 'revise';
    return {
      decision,
      feedback:
        typeof parsed.feedback === 'string' ? parsed.feedback : t('common.fallback.noSummary'),
      issues: Array.isArray(parsed.issues)
        ? parsed.issues.filter((v: unknown): v is string => typeof v === 'string')
        : [],
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((v: unknown): v is string => typeof v === 'string')
        : [],
      recommendedActions: parseRecommendedActions(parsed.recommendedActions),
    };
  } catch {
    return null;
  }
}

/**
 * Parse the reviewer's `recommendedActions` into structured follow-ups. Filed as
 * sub-issues on approve by fileReviewerFollowups (INT-1704). (INT-1954)
 */
function parseRecommendedActions(raw: unknown): ReviewResult['recommendedActions'] {
  if (!Array.isArray(raw)) return undefined;
  const actions = raw
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .map((a) => ({
      type: typeof a.type === 'string' && a.type ? a.type : 'follow-up',
      title: typeof a.title === 'string' ? a.title.trim() : '',
      location: typeof a.location === 'string' ? a.location : undefined,
    }))
    .filter((a) => a.title.length > 0);
  return actions.length ? actions : undefined;
}

/** Text fallback when no JSON reviewer result is present. */
function extractReviewerFromText(text: string): ReviewResult {
  const lower = text.toLowerCase();
  const decision = lower.includes('approve')
    ? 'approve'
    : lower.includes('reject')
      ? 'reject'
      : 'revise';
  return {
    decision,
    feedback: extractSummary(text),
    issues: [],
    suggestions: [],
  };
}

/** Brace-balanced scan for the JSON object containing `marker`. */
function findJsonObject(text: string, marker: string): string | null {
  const idx = text.indexOf(marker);
  if (idx < 0) return null;

  const start = text.lastIndexOf('{', idx);
  if (start < 0) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Detect a real failure declaration, not incidental "error"/"fail" prose. */
function isExplicitFailure(text: string): boolean {
  if (/"success"\s*:\s*false/i.test(text)) return true;
  return /\b(failed to|unable to|could not|couldn['’]t|cannot (?:complete|finish|proceed|continue)|giving up|abort(?:ed|ing))\b/i.test(text);
}

function extractSummary(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 10);
  if (lines.length === 0) return t('common.fallback.noSummary');
  const summary = lines[0].trim();
  return summary.length > 200 ? `${summary.slice(0, 200)}...` : summary;
}

function extractErrorMessage(text: string): string {
  const errorMatch = text.match(/(?:error|exception|failed?):\s*(.+)/i);
  if (errorMatch) return errorMatch[1].slice(0, 200);
  const lines = text.split('\n').filter((l) => /error|fail/i.test(l));
  return lines.length > 0 ? lines[0].slice(0, 200) : 'Unknown error';
}

/** JSON-first with text fallback — the canonical worker-output parse. */
export function parseWorkerResult(text: string): WorkerResult {
  return extractWorkerResultJson(text) ?? extractWorkerFromText(text);
}

/** JSON-first with text fallback — the canonical reviewer-output parse. */
export function parseReviewerResult(text: string): ReviewResult {
  return extractReviewerResultJson(text) ?? extractReviewerFromText(text);
}
