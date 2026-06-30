// ============================================
// OpenSwarm - Rate Limit Error
// Typed error for 429 / usage_limit_reached from CLI adapters
// ============================================

export class RateLimitError extends Error {
  constructor(
    /** Unix timestamp (seconds) when the quota resets, if provided by the API */
    public readonly resetsAt?: number,
    message?: string,
    /** Percent of the primary window consumed (0-100), from x-codex-* headers. */
    public readonly usedPercent?: number,
    /** Primary window length in minutes, from x-codex-* headers. */
    public readonly windowMinutes?: number,
  ) {
    super(message ?? 'Rate limit reached');
    this.name = 'RateLimitError';
  }
}

/**
 * Build a RateLimitError from a codex-responses 429. The x-codex-* headers carry
 * far more than the body: primary window usage %, reset time, window length. We
 * prefer the header reset, falling back to the body's resets_at. (INT-2192)
 */
export function rateLimitFromCodexHeaders(headers: Headers, body: string): RateLimitError {
  const num = (k: string): number | undefined => {
    const v = headers.get(k);
    const n = v == null ? NaN : parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const bodyResets = body.match(/"resets_at"\s*:\s*(\d+)/);
  const resetsAt = num('x-codex-primary-reset-at') ?? (bodyResets ? parseInt(bodyResets[1], 10) : undefined);
  const usedPercent = num('x-codex-primary-used-percent');
  const windowMinutes = num('x-codex-primary-window-minutes');

  const when = resetsAt ? new Date(resetsAt * 1000).toISOString() : 'an unknown time';
  const pct = usedPercent != null ? `${usedPercent}% used` : 'usage limit reached';
  const win = windowMinutes != null ? ` of ${windowMinutes}min window` : '';
  return new RateLimitError(resetsAt, `Codex ${pct}${win} — resets at ${when}`, usedPercent, windowMinutes);
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
