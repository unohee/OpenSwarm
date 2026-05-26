// ============================================
// OpenSwarm - LM Studio Adapter
// Created: 2026-05-13
// Purpose: Dedicated OpenAI-compatible adapter for LM Studio local server
// Dependencies: LocalModelAdapter
// Test Status: Covered by src/adapters/lmstudio.test.ts
// ============================================

import { LocalModelAdapter } from './local.js';
import type { CliRunOptions, CliRunResult } from './types.js';

const DEFAULT_LMSTUDIO_BASE_URL = 'http://localhost:1234';
const DEFAULT_LMSTUDIO_MODEL = 'local-model';

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export class LmStudioAdapter extends LocalModelAdapter {
  constructor() {
    super({
      name: 'lmstudio',
      endpoints: [normalizeBaseUrl(process.env.LMSTUDIO_BASE_URL ?? DEFAULT_LMSTUDIO_BASE_URL)],
      defaultModel: normalizeValue(process.env.LMSTUDIO_MODEL) ?? DEFAULT_LMSTUDIO_MODEL,
      apiKey: process.env.LMSTUDIO_API_KEY,
      logPrefix: 'LMStudio',
      noServerMessage: 'No LM Studio server found. Start LM Studio Local Server first, or set LMSTUDIO_BASE_URL.',
    });
  }

  async run(options: CliRunOptions): Promise<CliRunResult> {
    const model = await this.resolveModel(options.model);
    return super.run({ ...options, model });
  }

  private async resolveModel(requestedModel?: string): Promise<string> {
    const explicitModel = normalizeValue(requestedModel) ?? normalizeValue(process.env.LMSTUDIO_MODEL);
    if (explicitModel) return explicitModel;

    const loadedModels = await this.listModels();
    return loadedModels[0] ?? DEFAULT_LMSTUDIO_MODEL;
  }
}

function normalizeValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
