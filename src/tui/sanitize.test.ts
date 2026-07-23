import { describe, expect, it } from 'vitest';
import { safeIsoDate, sanitizeTerminalText } from './sanitize.js';

describe('terminal sanitization', () => {
  it('removes CSI, OSC, and control bytes while preserving layout whitespace', () => {
    expect(sanitizeTerminalText('\u001b[31mred\u001b[0m\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007\u0000\nnext'))
      .toBe('redlink\nnext');
  });

  it('does not render invalid timestamps', () => {
    expect(safeIsoDate('not-a-date')).toBeUndefined();
    expect(safeIsoDate('2026-07-23T00:00:00Z')).toBe('2026-07-23T00:00:00.000Z');
  });
});
