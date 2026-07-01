import { describe, it, expect } from 'vitest';
import { GLYPH, SPINNER_FRAMES, spinnerFrame } from './glyphs.js';
import { status } from './colors.js';

describe('glyphs — single status vocabulary (INT-2260)', () => {
  it('exposes one glyph per status kind', () => {
    expect(GLYPH.running).toBe('◐');
    expect(GLYPH.ok).toBe('✓');
    expect(GLYPH.err).toBe('✗');
    expect(GLYPH.warn).toBe('⚠');
    expect(GLYPH.revise).toBe('✎');
  });

  it('spinnerFrame cycles and is safe for any tick', () => {
    expect(spinnerFrame(0)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrame(SPINNER_FRAMES.length)).toBe(spinnerFrame(0)); // wraps
    expect(typeof spinnerFrame(-1)).toBe('string');
  });
});

describe('status console helper (INT-2260)', () => {
  // vitest runs non-TTY, so `c` strips color — glyph+text stays plain and the
  // console output matches the shared vocabulary without ANSI leaking into pipes.
  it('prepends the shared glyph and stays plain when not a TTY', () => {
    expect(status.ok('saved')).toBe('✓ saved');
    expect(status.err('boom')).toBe('✗ boom');
    expect(status.warn('careful')).toBe('⚠ careful');
    expect(status.line('running', 'working')).toBe('◐ working');
    expect(status.glyph('revise')).toBe('✎');
  });
});
