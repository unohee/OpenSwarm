import { describe, expect, it } from 'vitest';
import { parsePositiveIntegerOption, parseTcpPortOption } from './optionParsers.js';

describe('strict CLI numeric options', () => {
  it.each(['0', '-1', '1.5', '10abc', 'Infinity', ''])('rejects malformed positive integers: %s', (value) => {
    expect(() => parsePositiveIntegerOption(value)).toThrow('positive integer');
  });

  it('accepts a safe positive integer with surrounding whitespace', () => {
    expect(parsePositiveIntegerOption(' 600 ')).toBe(600);
  });

  it.each(['0', '65536', '1.5', 'abc'])('rejects invalid TCP ports: %s', (value) => {
    expect(() => parseTcpPortOption(value)).toThrow();
  });

  it.each([['1', 1], ['65535', 65535]])('accepts TCP port boundary %s', (value, expected) => {
    expect(parseTcpPortOption(value)).toBe(expected);
  });
});
