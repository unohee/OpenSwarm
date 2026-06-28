// Persist the dashboard's provider toggle across daemon restarts.
//
// switchProvider() only mutates the in-memory config, so every daemon restart reloads config.yaml
// (adapter: …) and silently reverts the choice — "I pressed Codex again but it's back to the old
// provider". We record the last toggle in a small JSON file next to config.yaml and re-apply it on
// boot. config.yaml itself (with its hand-written comments) is never rewritten.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdapterName } from '../adapters/types.js';

const OVERRIDE_DIR = join(homedir(), '.config', 'openswarm');
const OVERRIDE_PATH = join(OVERRIDE_DIR, 'provider-override.json');
// `claude` is intentionally excluded: it is an opt-in fallback provider, not a primary the operator
// should be able to pin via a persisted toggle (a stale claude pin with no credits hangs the loop).
const VALID: readonly Exclude<AdapterName, 'claude'>[] = ['codex', 'codex-responses', 'gpt', 'local', 'lmstudio', 'openrouter'];
const VALID_SET = new Set<Exclude<AdapterName, 'claude'>>(VALID);

/** The provider the user last selected via the dashboard, or undefined if never toggled. */
export function readProviderOverride(): AdapterName | undefined {
  try {
    if (!existsSync(OVERRIDE_PATH)) return undefined;
    const { provider } = JSON.parse(readFileSync(OVERRIDE_PATH, 'utf8')) as { provider?: string };
    return VALID_SET.has(provider as Exclude<AdapterName, 'claude'>) ? (provider as Exclude<AdapterName, 'claude'>) : undefined;
  } catch {
    return undefined;
  }
}

/** Record the user's provider choice so it survives a restart. Best-effort — never blocks the toggle. */
export function writeProviderOverride(provider: AdapterName): void {
  try {
    if (provider === 'claude') return;
    mkdirSync(OVERRIDE_DIR, { recursive: true });
    writeFileSync(OVERRIDE_PATH, `${JSON.stringify({ provider }, null, 2)}\n`, 'utf8');
  } catch {
    /* persistence is an optimization — a failed write must not break the switch */
  }
}
