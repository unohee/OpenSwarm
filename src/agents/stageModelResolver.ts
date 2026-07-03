// ============================================
// OpenSwarm - Stage model resolution (INT-2393)
// ============================================

import { getAdapter } from '../adapters/index.js';

/**
 * Resolve (and cache) an adapter's default model. `getDefaultModel` is heavy
 * (OAuth + live catalog), so results are cached per adapter name; failures
 * degrade to undefined. Used to fill the display model when a role omits it and
 * relies on the adapter default, so the TUI/dashboard aren't left blank.
 */
export function resolveAdapterDefaultModel(
  adapterName: string | undefined,
  cache: Map<string, Promise<string | undefined>>,
): Promise<string | undefined> {
  const cacheKey = adapterName ?? '<default>';
  let pending = cache.get(cacheKey);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => getAdapter(adapterName).getDefaultModel())
      .catch(() => undefined);
    cache.set(cacheKey, pending);
  }
  return pending;
}
