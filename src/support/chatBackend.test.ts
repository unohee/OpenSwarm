import { describe, it, expect } from 'vitest';
import { curatedModels, getDefaultChatModel } from './chatBackend.js';

describe('curatedModels (INT-1961)', () => {
  it('includes the provider default first and dedupes', () => {
    const m = curatedModels('openrouter');
    expect(m[0]).toBe(getDefaultChatModel('openrouter'));
    expect(new Set(m).size).toBe(m.length); // no dupes
    expect(m.length).toBeGreaterThan(1); // alias-derived options present
  });

  it('always yields at least the default for every provider', () => {
    for (const p of ['codex', 'codex-responses', 'gpt', 'local', 'lmstudio', 'openrouter'] as const) {
      const m = curatedModels(p);
      expect(m).toContain(getDefaultChatModel(p));
    }
  });
});
