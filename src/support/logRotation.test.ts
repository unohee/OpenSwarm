import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { rotateServiceLogs } from './logRotation.js';

const roots: string[] = [];
function logDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-log-rotation-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('rotateServiceLogs', () => {
  it('copy-truncates oversized logs and keeps fixed generations', () => {
    const dir = logDir();
    writeFileSync(join(dir, 'stdout.log'), 'new-current');
    writeFileSync(join(dir, 'stdout.log.1'), 'previous-one');
    writeFileSync(join(dir, 'stdout.log.2'), 'previous-two');

    expect(rotateServiceLogs({ logDir: dir, maxBytes: 4, generations: 2 })).toEqual({
      rotated: ['stdout.log'], skippedLocked: false,
    });
    expect(readFileSync(join(dir, 'stdout.log'), 'utf8')).toBe('');
    expect(readFileSync(join(dir, 'stdout.log.1'), 'utf8')).toBe('new-current');
    expect(readFileSync(join(dir, 'stdout.log.2'), 'utf8')).toBe('previous-one');
    expect(existsSync(join(dir, 'stdout.log.3'))).toBe(false);
  });

  it('does not rotate small files or follow symlinks/non-files', () => {
    const dir = logDir();
    writeFileSync(join(dir, 'stdout.log'), 'ok');
    mkdirSync(join(dir, 'stderr.log'));
    expect(rotateServiceLogs({ logDir: dir, maxBytes: 10 })).toEqual({ rotated: [], skippedLocked: false });
    expect(readFileSync(join(dir, 'stdout.log'), 'utf8')).toBe('ok');
  });

  it('skips an overlapping rotation and proceeds once the kernel-owned lock is released', () => {
    const dir = logDir();
    writeFileSync(join(dir, 'stdout.log'), 'oversized');
    const lock = new Database(join(dir, '.rotation-lock.db'), { timeout: 0 });
    lock.exec('BEGIN IMMEDIATE');
    try {
      expect(rotateServiceLogs({ logDir: dir, maxBytes: 4 }))
        .toEqual({ rotated: [], skippedLocked: true });
      expect(readFileSync(join(dir, 'stdout.log'), 'utf8')).toBe('oversized');
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }

    expect(rotateServiceLogs({ logDir: dir, maxBytes: 4 }))
      .toEqual({ rotated: ['stdout.log'], skippedLocked: false });
  });
});
