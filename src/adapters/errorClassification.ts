// ============================================
// OpenSwarm - Error classification (INT-2010)
// ============================================
//
// Distinguish "the agent's CLI/runtime failed to execute" (infrastructure) from
// "the agent ran and the work is wrong" (a real task failure). Infra failures —
// CLI non-zero exit, auth expiry, spawn ENOENT, timeouts, network drops — must
// NOT count toward the rejection/failure budgets that mark an issue durably
// STUCK: the task itself never got a fair attempt. This mirrors how RateLimitError
// is already special-cased (INT-1906), extended to the broader infra class.
//
// Observed in production (2026-06-28~29): `codex CLI failed with code 1` and
// `Reviewer execution failed: claude CLI failed with code 1` repeatedly drove
// otherwise-completable tasks to STUCK after worker had already edited files.

// Substrings (matched case-insensitively) that mark a failure as infrastructural
// rather than a verdict on the work. Kept conservative — code-logic errors
// (TypeError, assertion failures) are deliberately NOT here, so a genuinely
// broken edit still counts.
const INFRA_ERROR_PATTERNS = [
  'cli failed with code', // codex/claude CLI exited non-zero
  'exited with code',
  'exited with non-zero',
  'non-zero code',
  'enoent', // spawn: binary not found
  'spawn ', // spawn EACCES / spawn failures
  'etimedout',
  'timed out',
  'esockettimedout',
  'econnreset',
  'econnrefused',
  'enotfound',
  'socket hang up',
  'network error',
  'unauthorized',
  'not authenticated',
  'authentication failed',
  'invalid api key',
  'permission denied',
  '401',
  '403',
];

/**
 * True when `error` looks like an infrastructure/runtime failure of the agent
 * CLI rather than a substantive failure of the task. Used to keep such failures
 * out of the STUCK-inducing rejection/failure counts (they get a backoff retry
 * instead). (INT-2010)
 */
export function isInfraError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  if (!msg) return false;
  return INFRA_ERROR_PATTERNS.some((p) => msg.includes(p));
}
