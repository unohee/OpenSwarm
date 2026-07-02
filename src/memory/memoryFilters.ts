export const TRANSIENT_REVIEWER_FAILURE_PATTERNS = [
  /\b429\b/i,
  /usage_limit_reached/i,
  /rate limit/i,
  /responses error/i,
  /codex cli failed/i,
  /reviewer execution failed/i,
  /api error/i,
  /temporar(?:y|ily) unavailable/i,
  /timeout/i,
  /timed out/i,
];

export function isTransientReviewerFailure(feedback: string | undefined): boolean {
  if (!feedback) return false;
  return TRANSIENT_REVIEWER_FAILURE_PATTERNS.some(pattern => pattern.test(feedback));
}

export function isTransientReviewRejectionMemory(record: {
  type?: unknown;
  title?: unknown;
  content?: unknown;
}): boolean {
  if (record.type !== 'constraint') return false;
  const title = String(record.title ?? '');
  if (!title.startsWith('Review rejection:')) return false;
  return isTransientReviewerFailure(String(record.content ?? ''));
}
