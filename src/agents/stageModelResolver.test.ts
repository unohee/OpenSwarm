import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDefaultModel = vi.fn();

vi.mock('../adapters/index.js', async () => {
  const actual = await vi.importActual<typeof import('../adapters/index.js')>('../adapters/index.js');
  return { ...actual, getAdapter: () => ({ getDefaultModel }) };
});

import { resolveAdapterDefaultModel } from './stageModelResolver.js';

describe('resolveAdapterDefaultModel', () => {
  beforeEach(() => {
    getDefaultModel.mockReset();
  });

  it('resolves the adapter default model', async () => {
    getDefaultModel.mockResolvedValue('gpt-5.4-mini');
    const cache = new Map<string, Promise<string | undefined>>();
    await expect(resolveAdapterDefaultModel('codex-responses', cache)).resolves.toBe('gpt-5.4-mini');
  });

  it('caches per adapter — getDefaultModel runs once across repeated calls', async () => {
    getDefaultModel.mockResolvedValue('gpt-5.4-mini');
    const cache = new Map<string, Promise<string | undefined>>();
    await resolveAdapterDefaultModel('codex', cache);
    await resolveAdapterDefaultModel('codex', cache);
    expect(getDefaultModel).toHaveBeenCalledTimes(1);
  });

  it('keys an undefined adapter name under <default>', async () => {
    getDefaultModel.mockResolvedValue('m');
    const cache = new Map<string, Promise<string | undefined>>();
    await resolveAdapterDefaultModel(undefined, cache);
    await resolveAdapterDefaultModel(undefined, cache);
    expect(getDefaultModel).toHaveBeenCalledTimes(1);
    expect(cache.has('<default>')).toBe(true);
  });

  it('degrades to undefined when getDefaultModel throws', async () => {
    getDefaultModel.mockRejectedValue(new Error('no auth'));
    const cache = new Map<string, Promise<string | undefined>>();
    await expect(resolveAdapterDefaultModel('codex', cache)).resolves.toBeUndefined();
  });
});
