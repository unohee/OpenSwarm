// ============================================
// OpenSwarm - CLI Adapter Registry
// Barrel exports + adapter lookup
// ============================================

export type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  AdapterName,
  WorkerResult,
  ReviewResult,
  ProcessContext,
} from './types.js';

export { spawnCli } from './base.js';
export { ClaudeCliAdapter } from './claude.js';
export { CodexCliAdapter } from './codex.js';
export { GptCliAdapter } from './gpt.js';
export { LocalModelAdapter } from './local.js';
export { LmStudioAdapter } from './lmstudio.js';
export { registerProcess, getProcess, getAllProcesses, killProcess, startHealthChecker, stopHealthChecker } from './processRegistry.js';

import { ClaudeCliAdapter } from './claude.js';
import { CodexCliAdapter } from './codex.js';
import { GptCliAdapter } from './gpt.js';
import { LocalModelAdapter } from './local.js';
import { LmStudioAdapter } from './lmstudio.js';
import type { AdapterName, CliAdapter } from './types.js';

const adapters: Record<string, CliAdapter> = {
  claude: new ClaudeCliAdapter(),
  codex: new CodexCliAdapter(),
  gpt: new GptCliAdapter(),
  local: new LocalModelAdapter(),
  lmstudio: new LmStudioAdapter(),
};

let defaultAdapter: AdapterName = 'claude';

/**
 * Get an adapter by name. Defaults to 'claude'.
 */
export function getAdapter(name: string = defaultAdapter): CliAdapter {
  const adapter = adapters[name];
  if (!adapter) {
    throw new Error(`Unknown adapter: "${name}". Available: ${Object.keys(adapters).join(', ')}`);
  }
  return adapter;
}

export function setDefaultAdapter(name: AdapterName): void {
  if (!adapters[name]) {
    throw new Error(`Unknown adapter: "${name}". Available: ${Object.keys(adapters).join(', ')}`);
  }
  defaultAdapter = name;
}

export function getDefaultAdapterName(): AdapterName {
  return defaultAdapter;
}

/**
 * List adapters that are currently installed and available.
 */
export async function listAvailableAdapters(): Promise<string[]> {
  const results: string[] = [];
  for (const [name, adapter] of Object.entries(adapters)) {
    if (await adapter.isAvailable()) {
      results.push(name);
    }
  }
  return results;
}
