// ============================================
// OpenSwarm — provider/model compatibility
// ============================================
//
// One source of truth for "does this model id belong to that adapter?". Used
// by the provider switch (role/jobProfile/planner remapping) and the planner's
// model guard, so a config pinned for one provider never leaks an incompatible
// id into another provider's CLI/API. Observed failure without this:
// decomposition.plannerModel 'gpt-5.5' reaching `claude -p --model gpt-5.5`
// → API 404 on every decomposition attempt. (INT-2510)

import type { AdapterName } from './types.js';

/** Version-agnostic aliases the claude CLI resolves natively. */
const CLAUDE_ALIASES = new Set(['sonnet', 'opus', 'haiku']);

/**
 * Keep `model` only if it clearly belongs to `adapter`; otherwise return
 * undefined so the target adapter resolves its own default via
 * getDefaultModel(). No hardcoded per-provider model ids beyond stable
 * prefixes/aliases.
 */
export function mapModelForProvider(adapter: AdapterName, model: string | undefined): string | undefined {
  const current = (model || '').trim();
  if (!current) return undefined;
  if (adapter === 'codex' || adapter === 'codex-responses') {
    // ChatGPT-account Codex only runs gpt-* slugs; anything else → adapter default.
    return current.startsWith('gpt-') ? current : undefined;
  }
  if (adapter === 'claude') {
    // The claude CLI accepts claude-* ids and version-agnostic aliases.
    return current.startsWith('claude-') || CLAUDE_ALIASES.has(current) ? current : undefined;
  }
  // openrouter/gpt/local/lmstudio: a namespaced id ("vendor/model") may carry
  // over; a bare id from another provider usually won't — drop to the default.
  return current.includes('/') ? current : undefined;
}
