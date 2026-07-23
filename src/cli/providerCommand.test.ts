import { beforeEach, describe, expect, it, vi } from 'vitest';

const readProviderOverrideMock = vi.hoisted(() => vi.fn());
const writeProviderOverrideMock = vi.hoisted(() => vi.fn());
const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock('../core/providerOverride.js', () => ({
  readProviderOverride: readProviderOverrideMock,
  writeProviderOverride: writeProviderOverrideMock,
}));
vi.mock('../core/config.js', () => ({ loadConfig: loadConfigMock }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function statsResponse(adapters: unknown) {
  return { ok: true, json: async () => ({ adapters }) };
}

describe('provider command helpers', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    readProviderOverrideMock.mockReset();
    writeProviderOverrideMock.mockReset();
    loadConfigMock.mockReset();
    loadConfigMock.mockReturnValue({ adapter: 'codex-responses' });
  });

  describe('getProviderStatus', () => {
    it('prefers the live daemon and reports its enabled roles', async () => {
      fetchMock.mockResolvedValue(statsResponse({
        defaultAdapter: 'claude',
        worker: { adapter: 'claude', model: 'sonnet', enabled: true },
        reviewer: { adapter: 'claude', model: 'sonnet', enabled: true },
        tester: { adapter: 'claude', enabled: false },
      }));

      const { getProviderStatus } = await import('./providerCommand.js');
      const status = await getProviderStatus();

      expect(status).toMatchObject({ active: 'claude', source: 'daemon', daemonRunning: true });
      // A disabled role is not part of what the daemon is actually running.
      expect(status.roles).toEqual([
        { role: 'worker', adapter: 'claude', model: 'sonnet' },
        { role: 'reviewer', adapter: 'claude', model: 'sonnet' },
      ]);
      expect(readProviderOverrideMock).not.toHaveBeenCalled();
    });

    it('falls back to the persisted override when no daemon answers', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      readProviderOverrideMock.mockReturnValue('claude');

      const { getProviderStatus } = await import('./providerCommand.js');

      expect(await getProviderStatus()).toEqual({
        active: 'claude', source: 'override', daemonRunning: false, roles: [],
      });
    });

    it('falls back to config.yaml when there is neither a daemon nor an override', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      readProviderOverrideMock.mockReturnValue(undefined);

      const { getProviderStatus } = await import('./providerCommand.js');

      expect(await getProviderStatus()).toMatchObject({ active: 'codex-responses', source: 'config' });
    });

    it('ignores an unknown daemon adapter name rather than reporting it as active', async () => {
      fetchMock.mockResolvedValue(statsResponse({ defaultAdapter: 'retired-provider' }));
      readProviderOverrideMock.mockReturnValue('gpt');

      const { getProviderStatus } = await import('./providerCommand.js');

      expect(await getProviderStatus()).toMatchObject({ active: 'gpt', source: 'override' });
    });

    it('uses the registry default when the config is unreadable', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      readProviderOverrideMock.mockReturnValue(undefined);
      loadConfigMock.mockImplementation(() => { throw new Error('no config.yaml'); });

      const { getProviderStatus } = await import('./providerCommand.js');

      expect(await getProviderStatus()).toMatchObject({ active: 'codex', source: 'config' });
    });
  });

  describe('applyProvider', () => {
    it('switches a running daemon in place and persists the choice', async () => {
      fetchMock.mockResolvedValue({ ok: true, text: async () => '{"ok":true}' });

      const { applyProvider } = await import('./providerCommand.js');
      const result = await applyProvider('claude');

      expect(result).toEqual({ live: true });
      expect(writeProviderOverrideMock).toHaveBeenCalledWith('claude');
      const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
      expect(url).toContain('/api/provider');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ provider: 'claude' });
    });

    it('persists nothing when a reachable daemon rejects the switch', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'Invalid provider' });

      const { applyProvider } = await import('./providerCommand.js');
      const result = await applyProvider('claude');

      // A written override here would describe a provider the live process is not using.
      expect(result.live).toBe(false);
      expect(result.error).toContain('400');
      expect(writeProviderOverrideMock).not.toHaveBeenCalled();
    });

    it('records the override for the next boot when no daemon is reachable', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      const { applyProvider } = await import('./providerCommand.js');

      expect(await applyProvider('claude')).toEqual({ live: false });
      expect(writeProviderOverrideMock).toHaveBeenCalledWith('claude');
    });
  });

  describe('runProviderCommand', () => {
    it('rejects an unknown provider name against the live registry', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      readProviderOverrideMock.mockReturnValue('codex');
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { runProviderCommand } = await import('./providerCommand.js');

      expect(await runProviderCommand('not-a-provider')).toBe(1);
      expect(error.mock.calls[0]?.[0]).toContain('Unknown provider');
      expect(writeProviderOverrideMock).not.toHaveBeenCalled();
      error.mockRestore();
    });

    it('is a no-op when the daemon already runs the requested provider', async () => {
      fetchMock.mockResolvedValue(statsResponse({ defaultAdapter: 'claude' }));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { runProviderCommand } = await import('./providerCommand.js');

      expect(await runProviderCommand('claude')).toBe(0);
      expect(log.mock.calls[0]?.[0]).toContain('Already running');
      // Only the status probe ran — no switch was attempted.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      log.mockRestore();
    });

    it('prints status instead of prompting when stdin is not a TTY', async () => {
      fetchMock.mockResolvedValue(statsResponse({
        defaultAdapter: 'claude',
        worker: { adapter: 'claude', model: 'sonnet', enabled: true },
      }));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const isTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      const { runProviderCommand } = await import('./providerCommand.js');
      const code = await runProviderCommand(undefined);

      Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
      expect(code).toBe(0);
      expect(log.mock.calls.map(c => String(c[0])).join('\n')).toContain('Provider: claude');
      expect(writeProviderOverrideMock).not.toHaveBeenCalled();
      log.mockRestore();
    });
  });
});
