import { describe, expect, it } from 'vitest';
import { parseLinearTokenResponse } from './linearPkce.js';

describe('parseLinearTokenResponse', () => {
  it('requires access, refresh, and a positive expiry', () => {
    expect(parseLinearTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })).toEqual({
      accessToken: 'a', refreshToken: 'r', expiresIn: 3600,
    });
    expect(() => parseLinearTokenResponse({ access_token: 'a', expires_in: 3600 })).toThrow(/refresh_token/);
    expect(() => parseLinearTokenResponse({ access_token: 'a', refresh_token: '', expires_in: 3600 })).toThrow(/refresh_token/);
    expect(() => parseLinearTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 0 })).toThrow(/expires_in/);
  });
});
