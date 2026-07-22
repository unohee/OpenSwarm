import { describe, expect, it, vi } from 'vitest';
import type { AuthProfile, AuthProfileStore } from '../auth/index.js';

const ensureValidToken = vi.hoisted(() => vi.fn(async () => 'refreshed-token'));

vi.mock('../auth/index.js', () => ({
  AuthProfileStore: class {},
  ensureValidToken,
}));

import { refreshExpiredProfileForRetry } from './gpt.js';

describe('GPT forced token refresh', () => {
  it('clones a frozen auth profile instead of mutating shared state', async () => {
    const profile: AuthProfile = Object.freeze({
      type: 'oauth',
      provider: 'openai-gpt',
      access: 'old-token',
      refresh: 'refresh-token',
      expires: 123,
      clientId: 'client-id',
    });
    const setProfile = vi.fn();
    const store = {
      getProfile: vi.fn(() => profile),
      setProfile,
    } as unknown as AuthProfileStore;

    await expect(refreshExpiredProfileForRetry(store)).resolves.toBe('refreshed-token');
    expect(profile.expires).toBe(123);
    expect(setProfile).toHaveBeenCalledWith('openai-gpt:default', { ...profile, expires: 0 });
    expect(setProfile.mock.calls[0][1]).not.toBe(profile);
  });
});
