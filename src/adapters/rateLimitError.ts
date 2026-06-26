// ============================================
// OpenSwarm - Rate Limit Error
// Typed error for 429 / usage_limit_reached from CLI adapters
// ============================================

export class RateLimitError extends Error {
  constructor(
    /** Unix timestamp (seconds) when the quota resets, if provided by the API */
    public readonly resetsAt?: number,
    message?: string,
  ) {
    super(message ?? 'Rate limit reached');
    this.name = 'RateLimitError';
  }
}

/**
 * Scan combined stdout+stderr output for rate-limit signals.
 * Handles Codex format: JSON stream event with type=error carrying a message
 * that embeds the usage_limit_reached JSON (with resets_at timestamp).
 * Returns a RateLimitError if a rate-limit pattern is found, null otherwise.
 */
export function detectRateLimit(stdout: string, stderr: string): RateLimitError | null {
  const combined = stdout + '\n' + stderr;

  const hasSignal =
    combined.includes('usage_limit_reached') ||
    combined.includes('rate_limit_exceeded') ||
    combined.includes('"rate_limit_error"') ||
    (combined.includes('429') && /rate.{0,15}limit/i.test(combined));

  if (!hasSignal) return null;

  const resetsAtMatch = combined.match(/"resets_at"\s*:\s*(\d+)/);
  const resetsAt = resetsAtMatch ? parseInt(resetsAtMatch[1], 10) : undefined;

  const label = resetsAt
    ? `Rate limit reached (resets at ${new Date(resetsAt * 1000).toISOString()})`
    : 'Rate limit reached';

  return new RateLimitError(resetsAt, label);
}
