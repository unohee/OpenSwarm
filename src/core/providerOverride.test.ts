import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const homedirMock = vi.fn(() => '/tmp/openswarm-home');

vi.mock('node:os', () => ({ homedir: homedirMock }));

describe('providerOverride', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads and writes a valid override', async () => {
    const fs = await import('node:fs');
    fs.rmSync('/tmp/openswarm-home', { recursive: true, force: true });

    const { writeProviderOverride, readProviderOverride } = await import('./providerOverride.js');
    writeProviderOverride('codex');

    expect(readProviderOverride()).toBe('codex');
    expect(fs.readFileSync('/tmp/openswarm-home/.config/openswarm/provider-override.json', 'utf8')).toContain('"provider": "codex"');
  });

  it('returns undefined for missing or invalid files', async () => {
    const fs = await import('node:fs');
    fs.rmSync('/tmp/openswarm-home', { recursive: true, force: true });

    const { readProviderOverride } = await import('./providerOverride.js');
    expect(readProviderOverride()).toBeUndefined();

    fs.mkdirSync('/tmp/openswarm-home/.config/openswarm', { recursive: true });
    fs.writeFileSync('/tmp/openswarm-home/.config/openswarm/provider-override.json', '{not json', 'utf8');
    expect(readProviderOverride()).toBeUndefined();

    fs.writeFileSync('/tmp/openswarm-home/.config/openswarm/provider-override.json', JSON.stringify({ provider: 'unknown' }), 'utf8');
    expect(readProviderOverride()).toBeUndefined();
  });

  it('does not persist claude overrides', async () => {
    const fs = await import('node:fs');
    fs.rmSync('/tmp/openswarm-home', { recursive: true, force: true });

    const { writeProviderOverride, readProviderOverride } = await import('./providerOverride.js');
    writeProviderOverride('claude');

    expect(fs.existsSync('/tmp/openswarm-home/.config/openswarm/provider-override.json')).toBe(false);
    expect(readProviderOverride()).toBeUndefined();
  });

  it('ignores claude persisted values if the file is present', async () => {
    const fs = await import('node:fs');
    fs.rmSync('/tmp/openswarm-home', { recursive: true, force: true });
    fs.mkdirSync('/tmp/openswarm-home/.config/openswarm', { recursive: true });
    fs.writeFileSync('/tmp/openswarm-home/.config/openswarm/provider-override.json', JSON.stringify({ provider: 'claude' }), 'utf8');

    const { readProviderOverride } = await import('./providerOverride.js');
    expect(readProviderOverride()).toBeUndefined();
  });

  it('formats a loud mismatch warning naming both providers and the override file (INT-2408)', async () => {
    const { formatProviderOverrideMismatchWarning } = await import('./providerOverride.js');
    const msg = formatProviderOverrideMismatchWarning('codex', 'codex-responses');

    // Both values must appear so the divergence is obvious.
    expect(msg).toContain('"codex"');
    expect(msg).toContain('"codex-responses"');
    // Points at the actual file to delete, and reads as a warning.
    expect(msg).toContain('provider-override.json');
    expect(msg).toContain('overriding config.yaml');
    expect(msg).toContain('⚠️');
  });
});
