import { describe, it, expect } from 'vitest';
import { mapModelForProvider } from './modelCompat.js';

// Regression for INT-2510: decomposition.plannerModel 'gpt-5.5' leaked into
// `claude -p --model gpt-5.5` after a provider switch → API 404 on every
// decomposition attempt.
describe('mapModelForProvider', () => {
  it('codex keeps gpt-* slugs and drops everything else', () => {
    expect(mapModelForProvider('codex-responses', 'gpt-5.5')).toBe('gpt-5.5');
    expect(mapModelForProvider('codex', 'gpt-5.4-mini')).toBe('gpt-5.4-mini');
    expect(mapModelForProvider('codex-responses', 'sonnet')).toBeUndefined();
    expect(mapModelForProvider('codex-responses', 'qwen/qwen3-coder')).toBeUndefined();
  });

  it('claude keeps claude-* ids and version-agnostic aliases, drops foreign ids', () => {
    expect(mapModelForProvider('claude', 'sonnet')).toBe('sonnet');
    expect(mapModelForProvider('claude', 'opus')).toBe('opus');
    expect(mapModelForProvider('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(mapModelForProvider('claude', 'gpt-5.5')).toBeUndefined(); // the INT-2510 leak
    expect(mapModelForProvider('claude', 'openai/gpt-5')).toBeUndefined(); // config schema default
  });

  it('openrouter-style adapters keep namespaced ids only', () => {
    expect(mapModelForProvider('openrouter', 'anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
    expect(mapModelForProvider('openrouter', 'claude-sonnet-5')).toBeUndefined();
    expect(mapModelForProvider('gpt', 'sonnet')).toBeUndefined();
    expect(mapModelForProvider('local', 'qwen/qwen3-coder')).toBe('qwen/qwen3-coder');
  });

  it('empty/blank models resolve to undefined (adapter default)', () => {
    expect(mapModelForProvider('claude', undefined)).toBeUndefined();
    expect(mapModelForProvider('claude', '  ')).toBeUndefined();
  });
});
