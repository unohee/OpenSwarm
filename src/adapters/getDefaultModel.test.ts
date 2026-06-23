import { describe, it, expect } from 'vitest';
import { GptCliAdapter } from './gpt.js';
import { OpenRouterCliAdapter } from './openrouter.js';
import { CodexResponsesAdapter } from './codexResponses.js';

// Each adapter resolves its OWN provider-appropriate default — no cross-provider
// hardcoded model ids (the regression that 400'd codex-responses with claude).
describe('adapter.getDefaultModel', () => {
  it('gpt → an OpenAI model', async () => {
    expect(await new GptCliAdapter().getDefaultModel()).toMatch(/^gpt-/);
  });

  it('openrouter → a namespaced model id', async () => {
    expect(await new OpenRouterCliAdapter().getDefaultModel()).toContain('/');
  });

  it('codex-responses → a gpt-* model, never a claude model (regression guard)', async () => {
    const model = await new CodexResponsesAdapter().getDefaultModel();
    expect(model).toMatch(/^gpt-/);
    expect(model).not.toContain('claude');
  });
});
