import { describe, it, expect } from 'vitest';
import { deleteLastGrapheme } from './ChatInput.js';

describe('ChatInput deleteLastGrapheme', () => {
  it('deletes an emoji as one grapheme', () => {
    expect(deleteLastGrapheme('ok😀')).toBe('ok');
  });

  it('deletes a base character plus combining mark as one grapheme', () => {
    expect(deleteLastGrapheme('Cafe\u0301')).toBe('Caf');
  });
});
