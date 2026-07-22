import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clampDiscordText, getChatHistory, saveChatHistory, startTypingIndicator } from './discordCore.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.OPENSWARM_CHAT_HISTORY_FILE;
});

describe('Discord persisted chat history', () => {
  it('serializes concurrent updates in an owner-only snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openswarm-discord-history-'));
    const path = join(dir, 'history.json');
    process.env.OPENSWARM_CHAT_HISTORY_FILE = path;
    try {
      await Promise.all(Array.from({ length: 20 }, (_, index) => saveChatHistory({
        timestamp: new Date(index).toISOString(),
        user: `user-${index}`,
        userId: String(index),
        message: `message-${index}`,
        response: `response-${index}`,
      })));
      expect(await getChatHistory()).toHaveLength(20);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(20);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Discord outbound bounds', () => {
  it('clamps embed descriptions to the exact Discord limit', () => {
    const value = clampDiscordText('x'.repeat(5000), 4096);
    expect(value).toHaveLength(4096);
    expect(value.endsWith('…')).toBe(true);
  });

  it('observes initial and repeated typing failures without unhandled rejection', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sendTyping = vi.fn(async () => { throw new Error('no permission'); });
    const timer = startTypingIndicator({ sendTyping }, 100);
    await vi.runOnlyPendingTimersAsync();
    clearInterval(timer);
    expect(sendTyping.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(warn).toHaveBeenCalled();
  });
});
