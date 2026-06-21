// Persist the dashboard's provider toggle across daemon restarts.
//
// switchProvider() only mutated the in-memory config, so every daemon restart reloaded config.yaml
// (adapter: openrouter) and silently reverted the choice — "I pressed Codex again but it's back to
// OpenRouter". We record the last toggle in a small JSON file next to config.yaml and re-apply it on
// boot. config.yaml itself (with its hand-written comments) is never rewritten.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdapterName } from '../adapters/types.js';

// Computed per-call (not captured at module load) so it follows $HOME — correct if the home dir
// ever changes, and lets tests redirect to a temp dir instead of the real config.
const overrideDir = () => join(homedir(), '.config', 'openswarm');
const overridePath = () => join(overrideDir(), 'provider-override.json');
const VALID: readonly AdapterName[] = ['codex', 'codex-responses', 'gpt', 'local', 'lmstudio', 'openrouter', 'claude'];

/** The provider the user last selected via the dashboard, or undefined if never toggled. */
export function readProviderOverride(): AdapterName | undefined {
  try {
    if (!existsSync(overridePath())) return undefined;
    const { provider } = JSON.parse(readFileSync(overridePath(), 'utf8')) as { provider?: string };
    return VALID.includes(provider as AdapterName) ? (provider as AdapterName) : undefined;
  } catch {
    return undefined;
  }
}

/** Record the user's provider choice so it survives a restart. Best-effort — never blocks the toggle. */
export function writeProviderOverride(provider: AdapterName): void {
  try {
    mkdirSync(overrideDir(), { recursive: true });
    writeFileSync(overridePath(), `${JSON.stringify({ provider }, null, 2)}\n`, 'utf8');
  } catch {
    /* persistence is an optimization — a failed write must not break the switch */
  }
}
