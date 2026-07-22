import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock node:fs/promises and node:os BEFORE importing the module under test,
// since prOwnership.ts computes OWNERSHIP_PATH from homedir() at import time
// and every read/write goes through readFile/writeFile/mkdir. This keeps the
// test fully in-memory and never touches the real ~/.openswarm directory.
const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(),
}));
const atomicWriteFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => fsMock);
vi.mock('node:os', () => ({ homedir: () => '/test-home' }));
vi.mock('../support/atomicFile.js', () => ({ atomicWriteFile: atomicWriteFileMock }));
vi.mock('../support/fileLock.js', () => ({
  withFileLock: vi.fn(async (_path: string, operation: () => Promise<unknown>) => operation()),
}));

import {
  registerOwnedPR,
  isOwnedPR,
  removeOwnedPR,
  getOwnedPRsForRepo,
  getAllOwnedPRs,
  type OwnedPR,
} from './prOwnership.js';

const OWNERSHIP_DIR = resolve('/test-home', '.openswarm');
const OWNERSHIP_PATH = resolve(OWNERSHIP_DIR, 'pr-ownership.json');

const samplePR = (overrides: Partial<OwnedPR> = {}): OwnedPR => ({
  repo: 'owner/repo',
  prNumber: 1,
  branch: 'swarm/fix-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('prOwnership', () => {
  beforeEach(() => {
    fsMock.readFile.mockReset();
    atomicWriteFileMock.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('loadState fallback behavior', () => {
    it('returns an empty state when the file does not exist', async () => {
      fsMock.readFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      const all = await getAllOwnedPRs();

      expect(all).toEqual([]);
      expect(fsMock.readFile).toHaveBeenCalledWith(OWNERSHIP_PATH, 'utf-8');
    });

    it('fails closed when the file contains corrupt JSON', async () => {
      fsMock.readFile.mockResolvedValue('{ this is not valid json');

      await expect(getAllOwnedPRs()).rejects.toThrow(/ownership state is invalid/);
    });

    it('parses a well-formed persisted state', async () => {
      const stored = {
        prs: [samplePR(), samplePR({ prNumber: 2, branch: 'swarm/fix-2' })],
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      fsMock.readFile.mockResolvedValue(JSON.stringify(stored));

      const all = await getAllOwnedPRs();

      expect(all).toEqual(stored.prs);
    });
  });

  it('rejects structurally invalid persisted ownership rows', async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify({ prs: [{ repo: '', prNumber: -1 }], updatedAt: 'x' }));
    await expect(getAllOwnedPRs()).rejects.toThrow(/ownership state is invalid/);
  });

  describe('registerOwnedPR', () => {
    it('adds a new PR and persists it via mkdir + writeFile', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ prs: [], updatedAt: 'x' }));
      const pr = samplePR();

      await registerOwnedPR(pr);

      expect(atomicWriteFileMock).toHaveBeenCalledTimes(1);
      const [writtenPath, writtenBody, mode] = atomicWriteFileMock.mock.calls[0];
      expect(writtenPath).toBe(OWNERSHIP_PATH);
      expect(mode).toBe(0o600);
      const written = JSON.parse(writtenBody as string);
      expect(written.prs).toEqual([pr]);
      expect(written.updatedAt).toBe('2026-07-10T12:00:00.000Z');
    });

    it('does not duplicate an already-owned PR (same repo + prNumber)', async () => {
      const existing = samplePR();
      fsMock.readFile.mockResolvedValue(JSON.stringify({ prs: [existing], updatedAt: 'x' }));

      await registerOwnedPR(samplePR({ branch: 'swarm/different-branch' }));

      expect(atomicWriteFileMock).not.toHaveBeenCalled();
    });

    it('treats PRs with the same number in different repos as distinct', async () => {
      const existing = samplePR({ repo: 'owner/repo-a' });
      fsMock.readFile.mockResolvedValue(JSON.stringify({ prs: [existing], updatedAt: 'x' }));

      await registerOwnedPR(samplePR({ repo: 'owner/repo-b' }));

      expect(atomicWriteFileMock).toHaveBeenCalledTimes(1);
      const written = JSON.parse(atomicWriteFileMock.mock.calls[0][1] as string);
      expect(written.prs).toHaveLength(2);
    });
  });

  describe('isOwnedPR', () => {
    it('returns true for a registered repo + prNumber pair', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ prs: [samplePR()], updatedAt: 'x' }));

      await expect(isOwnedPR('owner/repo', 1)).resolves.toBe(true);
    });

    it('returns false for an unregistered prNumber', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ prs: [samplePR()], updatedAt: 'x' }));

      await expect(isOwnedPR('owner/repo', 999)).resolves.toBe(false);
    });

    it('returns false for a matching prNumber in a different repo', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ prs: [samplePR()], updatedAt: 'x' }));

      await expect(isOwnedPR('owner/other-repo', 1)).resolves.toBe(false);
    });

    it('returns false against an empty state (no persisted file)', async () => {
      fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

      await expect(isOwnedPR('owner/repo', 1)).resolves.toBe(false);
    });
  });

  describe('removeOwnedPR', () => {
    it('removes a matching PR and persists the change', async () => {
      const toRemove = samplePR();
      const toKeep = samplePR({ prNumber: 2, branch: 'swarm/fix-2' });
      fsMock.readFile.mockResolvedValue(JSON.stringify({ prs: [toRemove, toKeep], updatedAt: 'x' }));

      await removeOwnedPR('owner/repo', 1);

      expect(atomicWriteFileMock).toHaveBeenCalledTimes(1);
      const written = JSON.parse(atomicWriteFileMock.mock.calls[0][1] as string);
      expect(written.prs).toEqual([toKeep]);
    });

    it('is a no-op (no write) when the PR is not found', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ prs: [samplePR()], updatedAt: 'x' }));

      await removeOwnedPR('owner/repo', 404);

      expect(atomicWriteFileMock).not.toHaveBeenCalled();
    });

    it('is a no-op against an empty state', async () => {
      fsMock.readFile.mockRejectedValue(new Error('ENOENT'));

      await removeOwnedPR('owner/repo', 1);

      expect(atomicWriteFileMock).not.toHaveBeenCalled();
    });
  });

  describe('getOwnedPRsForRepo', () => {
    it('filters owned PRs by repo', async () => {
      const repoAPr = samplePR({ repo: 'owner/repo-a' });
      const repoBPr = samplePR({ repo: 'owner/repo-b', prNumber: 2 });
      fsMock.readFile.mockResolvedValue(JSON.stringify({ prs: [repoAPr, repoBPr], updatedAt: 'x' }));

      await expect(getOwnedPRsForRepo('owner/repo-a')).resolves.toEqual([repoAPr]);
    });

    it('returns an empty array when no PRs match the repo', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ prs: [samplePR()], updatedAt: 'x' }));

      await expect(getOwnedPRsForRepo('owner/nonexistent')).resolves.toEqual([]);
    });
  });

  describe('getAllOwnedPRs', () => {
    it('returns every persisted PR regardless of repo', async () => {
      const prs = [samplePR({ repo: 'owner/a' }), samplePR({ repo: 'owner/b', prNumber: 2 })];
      fsMock.readFile.mockResolvedValue(JSON.stringify({ prs, updatedAt: 'x' }));

      await expect(getAllOwnedPRs()).resolves.toEqual(prs);
    });
  });
});
