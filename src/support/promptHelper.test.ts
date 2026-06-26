import { describe, it, expect, vi } from 'vitest';
import { prepareInput, resolveChoice, resolveConfirm, type ChoiceOption } from './promptHelper.js';
import { PassThrough } from 'node:stream';

const opts: ChoiceOption<string>[] = [
  { label: 'local', value: 'L' },
  { label: 'linear', value: 'N' },
];

describe('resolveChoice', () => {
  it('matches a 1-based index', () => {
    expect(resolveChoice('1', opts)?.value).toBe('L');
    expect(resolveChoice('2', opts)?.value).toBe('N');
  });
  it('matches an exact label case-insensitively', () => {
    expect(resolveChoice('LINEAR', opts)?.value).toBe('N');
    expect(resolveChoice(' local ', opts)?.value).toBe('L');
  });
  it('returns null for out-of-range index, unknown label, or blank', () => {
    expect(resolveChoice('0', opts)).toBeNull();
    expect(resolveChoice('3', opts)).toBeNull();
    expect(resolveChoice('nope', opts)).toBeNull();
    expect(resolveChoice('', opts)).toBeNull();
  });
});

describe('prepareInput', () => {
  it('disables raw mode on TTY streams and sets utf8 encoding', () => {
    const input = new PassThrough() as PassThrough & { setRawMode?: ReturnType<typeof vi.fn> };
    const setRawMode = vi.fn();
    const setEncoding = vi.fn();
    input.setRawMode = setRawMode;
    input.setEncoding = setEncoding;

    expect(prepareInput(input)).toBe(input);
    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(setEncoding).toHaveBeenCalledWith('utf8');
  });

  it('sets utf8 encoding even when raw mode is unavailable', () => {
    const input = new PassThrough() as PassThrough & { setEncoding?: ReturnType<typeof vi.fn> };
    const setEncoding = vi.fn();
    input.setEncoding = setEncoding;

    expect(prepareInput(input)).toBe(input);
    expect(setEncoding).toHaveBeenCalledWith('utf8');
  });
});

describe('resolveConfirm', () => {
  it('takes the default on blank', () => {
    expect(resolveConfirm('', true)).toBe(true);
    expect(resolveConfirm('  ', false)).toBe(false);
  });
  it('parses yes/no variants', () => {
    for (const y of ['y', 'Y', 'yes', 'true']) expect(resolveConfirm(y, false)).toBe(true);
    for (const n of ['n', 'N', 'no', 'false']) expect(resolveConfirm(n, true)).toBe(false);
  });
  it('falls back to default on unrecognized input', () => {
    expect(resolveConfirm('maybe', true)).toBe(true);
    expect(resolveConfirm('maybe', false)).toBe(false);
  });
});
