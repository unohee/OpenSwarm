import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendWebhook, type WebhookPayload } from './pairWebhook.js';

afterEach(() => vi.unstubAllGlobals());

const payload: WebhookPayload = {
  event: 'pair_started',
  timestamp: '2026-07-22T00:00:00.000Z',
  session: { id: 's', taskId: 't', taskTitle: 'task', status: 'running', attempts: 1, maxAttempts: 2, durationMs: 0 },
};

describe('sendWebhook', () => {
  it('passes a bounded signal and cancels an unread response body', async () => {
    const cancel = vi.fn(async () => {});
    const response = { ok: false, status: 500, statusText: 'bad', body: { cancel } } as unknown as Response;
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendWebhook('https://example.test/hook', payload)).resolves.toMatchObject({ success: false, statusCode: 500 });
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
