import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampDiscordText, startTypingIndicator } from './discordCore.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
