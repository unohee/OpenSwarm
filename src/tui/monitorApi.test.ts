import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchIssues, fetchStuck, fetchTasks } from './monitorApi.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('monitorApi', () => {
  it('surfaces non-2xx pipeline responses instead of mapping an empty table', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'daemon exploded' }), { status: 500 })));

    await expect(fetchTasks(3847)).rejects.toThrow('GET /api/pipeline failed: HTTP 500: daemon exploded');
  });

  it('surfaces non-2xx stuck issue responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));

    await expect(fetchStuck(3847)).rejects.toThrow('GET /api/stuck-issues failed: HTTP 502: bad gateway');
  });

  it('checks GraphQL HTTP errors before reading GraphQL payloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: 'graphql down' }] }), { status: 503 })));

    await expect(fetchIssues(3847)).rejects.toThrow('POST /graphql failed: HTTP 503: graphql down');
  });
});
