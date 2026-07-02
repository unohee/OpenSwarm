import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown.js';

describe('renderMarkdown (INT-1943)', () => {
  it('returns empty for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('renders prose and preserves the words', () => {
    const out = renderMarkdown('Hello **world** and `code`.');
    expect(out).toContain('Hello');
    expect(out).toContain('world');
    expect(out).toContain('code');
  });

  it('renders a list and a fenced code block without throwing', () => {
    const out = renderMarkdown('- a\n- b\n\n```ts\nconst x = 1;\n```');
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).toContain('const x = 1;');
  });

  it('trims trailing whitespace', () => {
    expect(renderMarkdown('hi\n\n\n')).not.toMatch(/\s$/);
  });

  it('strips terminal control sequences from assistant-controlled markdown', () => {
    const out = renderMarkdown('\x1b]52;c;AAAA\x07Hello \x1b[31mred\x1b[0m');

    expect(out).toContain('Hello');
    expect(out).toContain('red');
    expect(out).not.toContain('AAAA');
    expect(out).not.toContain('\x1b]52');
    expect(out).not.toContain('\x1b[31m');
  });
});
