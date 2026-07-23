import { afterEach, describe, expect, it, vi } from 'vitest';

const discord = vi.hoisted(() => ({
  instances: [] as Array<{
    once: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    login: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    user: { tag: string };
    channels: { fetch: ReturnType<typeof vi.fn> };
  }>,
  nextLoginError: null as Error | null,
}));

vi.mock('discord.js', async () => {
  const actual = await vi.importActual<typeof import('discord.js')>('discord.js');
  return {
    ...actual,
    Client: class {
      once = vi.fn();
      on = vi.fn();
      login = vi.fn(async () => {
        const error = discord.nextLoginError;
        discord.nextLoginError = null;
        if (error) throw error;
        return 'token';
      });
      destroy = vi.fn(async () => {});
      user = { tag: 'test-bot' };
      channels = { fetch: vi.fn() };
      constructor() {
        discord.instances.push(this);
      }
    },
  };
});

import { client, initDiscord, stopDiscord } from './discordCore.js';

describe('Discord client lifecycle', () => {
  afterEach(async () => {
    await stopDiscord();
    discord.instances.length = 0;
    discord.nextLoginError = null;
  });

  it('destroys the old client before a successful replacement', async () => {
    await initDiscord('first-token', 'channel');
    const first = discord.instances[0];
    await initDiscord('second-token', 'channel');
    const second = discord.instances[1];

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.login).toHaveBeenCalledWith('second-token');
    expect(client).toBe(second);
  });

  it('destroys a replacement whose login fails and does not retain it', async () => {
    discord.nextLoginError = new Error('login failed');
    await expect(initDiscord('bad-token', 'channel')).rejects.toThrow('login failed');

    expect(discord.instances[0].destroy).toHaveBeenCalledTimes(1);
    expect(client).toBeNull();
  });
});
