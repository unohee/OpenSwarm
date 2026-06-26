import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatInputDebug, inputDebugEnabled, appendInputDebug } from './inputDebug.js';

describe('formatInputDebug (INT-1964)', () => {
  it('shows code points so multibyte doubling is visible', () => {
    expect(formatInputDebug('이')).toBe('input="이" len=1 cp=[51060]');
    // ink-level doubling would surface as two code points in ONE event:
    expect(formatInputDebug('이이')).toBe('input="이이" len=2 cp=[51060,51060]');
  });

  it('records active key flags', () => {
    expect(formatInputDebug('', { return: true })).toContain('keys=return');
    expect(formatInputDebug('a', { ctrl: true, meta: true })).toContain('keys=ctrl+meta');
  });

  it('ascii is single code point (the non-doubled case)', () => {
    expect(formatInputDebug(' ')).toBe('input=" " len=1 cp=[32]');
  });
});

describe('inputDebugEnabled (INT-1964)', () => {
  it('honors OPENSWARM_DEBUG_INPUT truthy values', () => {
    expect(inputDebugEnabled({ OPENSWARM_DEBUG_INPUT: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(inputDebugEnabled({ OPENSWARM_DEBUG_INPUT: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(inputDebugEnabled({ OPENSWARM_DEBUG_INPUT: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(inputDebugEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('appendInputDebug (INT-1964)', () => {
  it('appends diagnostic lines and never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'indbg-'));
    try {
      const path = join(dir, 'nested', 'input-debug.log');
      appendInputDebug('이', {}, path);
      appendInputDebug('a', { return: true }, path);
      const lines = readFileSync(path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('cp=[51060]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('swallows write errors (invalid path)', () => {
    expect(() => appendInputDebug('x', {}, '/this/should/not/exist/\0/bad')).not.toThrow();
  });
});
