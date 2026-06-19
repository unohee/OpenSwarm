import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addForwardCompatModels, getCodexModelIds, DEFAULT_CODEX_MODELS } from './codexModels.js';

describe('addForwardCompatModels', () => {
  it('de-dupes while preserving order', () => {
    expect(addForwardCompatModels(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('surfaces a synthetic slug when a compatible template is present', () => {
    // gpt-5.3-codex template → gpt-5.4 / gpt-5.4-mini / gpt-5.5 / spark synthesized
    const out = addForwardCompatModels(['gpt-5.3-codex']);
    expect(out).toContain('gpt-5.3-codex');
    expect(out).toContain('gpt-5.4');
    expect(out).toContain('gpt-5.5');
    expect(out).toContain('gpt-5.3-codex-spark');
  });

  it('does not synthesize when no template matches', () => {
    expect(addForwardCompatModels(['gpt-5-codex'])).toEqual(['gpt-5-codex']);
  });
});

describe('getCodexModelIds — offline sources', () => {
  let home: string;
  const origEnv = process.env.CODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    process.env.CODEX_HOME = home;
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = origEnv;
    rmSync(home, { recursive: true, force: true });
  });

  it('returns the curated fallback when no token and no local sources', async () => {
    const models = await getCodexModelIds();
    expect(models).toEqual(addForwardCompatModels(DEFAULT_CODEX_MODELS));
    expect(models[0]).toBe('gpt-5-codex');
  });

  it('puts the config.toml default model first', async () => {
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-5.4"\nmodel_provider = "openai"\n');
    const models = await getCodexModelIds();
    expect(models[0]).toBe('gpt-5.4');
  });

  it('ignores `model` keys inside a [section] (top-level only)', async () => {
    writeFileSync(join(home, 'config.toml'), '[profiles.foo]\nmodel = "should-not-win"\n');
    const models = await getCodexModelIds();
    expect(models[0]).toBe('gpt-5-codex'); // falls through to the curated fallback
    expect(models).not.toContain('should-not-win');
  });

  it('merges models_cache.json entries sorted by priority', async () => {
    writeFileSync(
      join(home, 'models_cache.json'),
      JSON.stringify({
        models: [
          { slug: 'cached-low', priority: 50 },
          { slug: 'cached-high', priority: 1 },
          { slug: 'hidden-one', priority: 2, visibility: 'hidden' },
        ],
      }),
    );
    const models = await getCodexModelIds();
    expect(models).toContain('cached-high');
    expect(models).toContain('cached-low');
    expect(models).not.toContain('hidden-one'); // hidden visibility filtered
    expect(models.indexOf('cached-high')).toBeLessThan(models.indexOf('cached-low'));
  });
});

describe('getCodexModelIds — live API', () => {
  const origEnv = process.env.CODEX_HOME;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = origEnv;
    vi.unstubAllGlobals();
  });

  it('uses the live backend, sorts by priority, filters hidden, keeps supported_in_api:false', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          models: [
            { slug: 'gpt-5.4', priority: 2, supported_in_api: true },
            { slug: 'gpt-5.3-codex', priority: 1, supported_in_api: true },
            { slug: 'gpt-5.3-codex-spark', priority: 3, supported_in_api: false },
            { slug: 'legacy-hidden', priority: 0, visibility: 'hide' },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const models = await getCodexModelIds('token-abc');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('chatgpt.com/backend-api/codex/models');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer token-abc' });

    // priority order: gpt-5.3-codex (1) < gpt-5.4 (2) < spark (3); hidden dropped;
    // supported_in_api:false (spark) is kept.
    expect(models.slice(0, 3)).toEqual(['gpt-5.3-codex', 'gpt-5.4', 'gpt-5.3-codex-spark']);
    expect(models).not.toContain('legacy-hidden');
  });

  it('falls back to offline sources when the live call is not ok', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    process.env.CODEX_HOME = home;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    try {
      const models = await getCodexModelIds('bad-token');
      expect(models).toEqual(addForwardCompatModels(DEFAULT_CODEX_MODELS));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
