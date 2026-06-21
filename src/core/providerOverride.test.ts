import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProviderOverride, writeProviderOverride } from './providerOverride.js';

// providerOverride resolves its path via os.homedir() → $HOME on POSIX. Point HOME at a temp dir so
// tests never touch the real ~/.config/openswarm/provider-override.json.
describe('providerOverride', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'provover-'));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('returns undefined when no override file exists', () => {
    expect(readProviderOverride()).toBeUndefined();
  });

  it('round-trips a written provider', () => {
    writeProviderOverride('codex');
    expect(readProviderOverride()).toBe('codex');
    writeProviderOverride('openrouter');
    expect(readProviderOverride()).toBe('openrouter');
  });

  it('persists the new claude adapter', () => {
    writeProviderOverride('claude');
    expect(readProviderOverride()).toBe('claude');
  });

  it('ignores an invalid provider value in the file', () => {
    mkdirSync(join(home, '.config', 'openswarm'), { recursive: true });
    writeFileSync(join(home, '.config', 'openswarm', 'provider-override.json'), JSON.stringify({ provider: 'bogus' }));
    expect(readProviderOverride()).toBeUndefined();
  });

  it('ignores a corrupt file instead of throwing', () => {
    mkdirSync(join(home, '.config', 'openswarm'), { recursive: true });
    writeFileSync(join(home, '.config', 'openswarm', 'provider-override.json'), 'not json{');
    expect(readProviderOverride()).toBeUndefined();
  });
});
