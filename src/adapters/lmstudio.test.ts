// ============================================
// OpenSwarm - LM Studio Adapter Tests
// Created: 2026-05-13
// Purpose: Verify dedicated LM Studio adapter wiring and OpenAI-compatible probing
// Dependencies: vitest
// Test Status: npm run test -- src/adapters/lmstudio.test.ts
// ============================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LmStudioAdapter } from './lmstudio.js';
import { getAdapter } from './index.js';

describe('LmStudioAdapter', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('registers as a named adapter', () => {
    const adapter = getAdapter('lmstudio');

    expect(adapter.name).toBe('lmstudio');
    expect(adapter.capabilities.supportsModelSelection).toBe(true);
  });

  it('checks LM Studio default /v1/models endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new LmStudioAdapter();
    await expect(adapter.isAvailable()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:1234/v1/models',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
    expect(adapter.getActiveUrl()).toBe('http://localhost:1234');
  });

  it('uses LMSTUDIO_BASE_URL and optional bearer API key', async () => {
    process.env.LMSTUDIO_BASE_URL = 'http://127.0.0.1:4321/';
    process.env.LMSTUDIO_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new LmStudioAdapter();
    await expect(adapter.isAvailable()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4321/v1/models',
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-key',
        },
      }),
    );
  });

  it('auto-selects the loaded LM Studio model when no override is provided', async () => {
    delete process.env.LMSTUDIO_MODEL;
    delete process.env.LMSTUDIO_API_KEY;
    process.env.LMSTUDIO_BASE_URL = 'http://127.0.0.1:4321/';

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'gemma-4-26b-a4b-it-mlx' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'gemma-4-26b-a4b-it-mlx' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'LM Studio is ready.' }, finish_reason: 'stop' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new LmStudioAdapter();
    const result = await adapter.run({
      prompt: 'Say hello',
      cwd: process.cwd(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('LM Studio is ready.');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:4321/v1/models',
      expect.any(Object),
    );

    const chatCall = fetchMock.mock.calls.at(-1);
    expect(chatCall?.[0]).toBe('http://127.0.0.1:4321/v1/chat/completions');
    const body = JSON.parse(chatCall?.[1]?.body as string) as { model: string };
    expect(body.model).toBe('gemma-4-26b-a4b-it-mlx');
  });
});
