// ============================================
// OpenSwarm - Run ledger conflict scope
// ============================================
//
// Predicted write sets for same-repository admission. The ledger keeps these
// helpers at arm's length so claimRun() reads as a policy decision rather than
// string normalization, and so the rules can be tested without a database.

/** Scope entries the planner emits when it could not determine a write set. */
const UNKNOWN_SCOPE_MARKER = 'unknown-file-scope';

/**
 * Normalize a predicted write set for comparison: repository-relative, forward
 * slashes, case-insensitive. Anything unusable (non-array, non-string entries,
 * the unknown marker) drops out, so an empty result means "scope unknown".
 */
export function normalizeConflictScope(entries: unknown): Set<string> {
  if (!Array.isArray(entries)) return new Set();
  const scope = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const normalized = entry.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    if (normalized && normalized !== UNKNOWN_SCOPE_MARKER) scope.add(normalized);
  }
  return scope;
}

/** Read the scope a live run recorded in its metadata blob. */
export function metadataConflictScope(metadata: unknown): Set<string> {
  if (!metadata || typeof metadata !== 'object') return new Set();
  return normalizeConflictScope((metadata as { fileScope?: unknown }).fileScope);
}

export function scopesOverlap(left: Set<string>, right: Set<string>): boolean {
  for (const file of left) {
    if (right.has(file)) return true;
  }
  return false;
}

/**
 * Decide whether a claim may join the runs already live in one repository.
 *
 * The cap controls capacity; this controls safety inside that capacity.
 * Unknown scope on either side fails closed — worktrees isolate filesystem
 * writes, but they do not make two unknown write sets safe to merge.
 */
export function admitsConflictScope(
  requested: unknown,
  activeScopes: readonly unknown[],
): boolean {
  if (activeScopes.length === 0) return true;
  const requestedScope = normalizeConflictScope(requested);
  if (requestedScope.size === 0) return false;
  for (const active of activeScopes) {
    const activeScope = metadataConflictScope(active);
    if (activeScope.size === 0 || scopesOverlap(requestedScope, activeScope)) return false;
  }
  return true;
}
