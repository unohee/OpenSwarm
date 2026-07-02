import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getStats = vi.fn();

vi.mock('../registry/sqliteStore.js', () => ({
  getRegistryStore: () => ({ getStats }),
  closeRegistryStore: vi.fn(),
}));

describe('checkHandler', () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'openswarm-check-'));
    originalCwd = process.cwd();
    getStats.mockReset();
    getStats.mockReturnValue({
      total: 0,
      deprecated: 0,
      untested: 0,
      highRisk: 0,
      withWarnings: 0,
      byKind: [],
      byStatus: [],
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  it('scopes --stats to the current project when --project is omitted', async () => {
    await mkdir(tmp, { recursive: true });
    await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: '@intrect/project-a' }), 'utf-8');
    process.chdir(tmp);

    const { handleCheck } = await import('./checkHandler.js');
    await handleCheck(undefined, { stats: true });

    expect(getStats).toHaveBeenCalledWith('project-a');
  });
});
