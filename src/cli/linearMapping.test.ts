import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getProfileMock = vi.fn();
vi.mock('../auth/index.js', () => ({
  AuthProfileStore: vi.fn().mockImplementation(function AuthProfileStore(this: unknown) {
    return { getProfile: getProfileMock };
  }),
  ensureValidToken: vi.fn(),
}));

const loadConfigMock = vi.fn();
vi.mock('../core/config.js', () => ({
  loadConfig: (...args: unknown[]) => loadConfigMock(...args),
}));

const { resolveLinearCredential } = await import('./linearMapping.js');

describe('resolveLinearCredential (INT-2619)', () => {
  const originalEnv = process.env.LINEAR_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    getProfileMock.mockReturnValue(undefined);
    loadConfigMock.mockReturnValue({ linearApiKey: '' });
    delete process.env.LINEAR_API_KEY;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = originalEnv;
  });

  it('returns null when no OAuth profile, env var, or config apiKey is present', async () => {
    expect(await resolveLinearCredential()).toBeNull();
  });

  it('falls back to LINEAR_API_KEY when no OAuth profile is stored', async () => {
    process.env.LINEAR_API_KEY = 'env-key';
    expect(await resolveLinearCredential()).toEqual({ apiKey: 'env-key' });
  });

  it('falls back to config.yaml `linear.apiKey` when neither OAuth profile nor env var is present (INT-2619)', async () => {
    // This is the exact gap the reviewer caught: ensureTaskSource() initializes
    // Linear from config.linearApiKey too, so the mapping preflight must check
    // the same source or it wrongly concludes "Linear isn't configured" and lets
    // filing proceed without a project.
    loadConfigMock.mockReturnValue({ linearApiKey: 'config-key' });
    expect(await resolveLinearCredential()).toEqual({ apiKey: 'config-key' });
  });

  it('prefers the OAuth profile over env var and config apiKey', async () => {
    getProfileMock.mockReturnValue({ provider: 'linear' });
    process.env.LINEAR_API_KEY = 'env-key';
    loadConfigMock.mockReturnValue({ linearApiKey: 'config-key' });
    const { ensureValidToken } = await import('../auth/index.js');
    vi.mocked(ensureValidToken).mockResolvedValue('oauth-token');
    expect(await resolveLinearCredential()).toEqual({ accessToken: 'oauth-token' });
  });
});
