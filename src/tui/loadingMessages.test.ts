import { describe, it, expect } from 'vitest';
import { spinnerFrame, loadingMessage, LOADING_MESSAGES, SPINNER_FRAMES } from './loadingMessages.js';

describe('loading flavor (INT-1813 follow-up)', () => {
  it('keeps the blessed-era loading lines and braille frames', () => {
    expect(LOADING_MESSAGES[0]).toBe('Initializing cogitator arrays');
    expect(LOADING_MESSAGES).toContain('Interfacing with the Noosphere');
    expect(SPINNER_FRAMES[0]).toBe('⣾');
    expect(SPINNER_FRAMES).toHaveLength(8);
  });

  it('spinnerFrame cycles through the frames', () => {
    expect(spinnerFrame(0)).toBe('⣾');
    expect(spinnerFrame(SPINNER_FRAMES.length)).toBe('⣾'); // wraps
    expect(spinnerFrame(1)).toBe('⣽');
  });

  it('loadingMessage advances once per period and honors the base offset', () => {
    expect(loadingMessage(0, 0)).toBe(LOADING_MESSAGES[0]);
    // 2500ms / 120ms ≈ 21 ticks before the message advances.
    expect(loadingMessage(20, 0)).toBe(LOADING_MESSAGES[0]);
    expect(loadingMessage(21, 0)).toBe(LOADING_MESSAGES[1]);
    expect(loadingMessage(0, 4)).toBe(LOADING_MESSAGES[4]);
  });
});
