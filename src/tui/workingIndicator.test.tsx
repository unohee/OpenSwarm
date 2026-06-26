import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { WorkingIndicator } from './components/WorkingIndicator.js';

describe('WorkingIndicator (INT-1813 follow-up)', () => {
  it('renders a braille frame + the starting loading line', () => {
    const f = render(<WorkingIndicator startIndex={4} />).lastFrame()!;
    expect(f).toContain('Interfacing with the Noosphere'); // LOADING_MESSAGES[4]
    expect(f).toMatch(/[⣾⣽⣻⢿⡿⣟⣯⣷]/); // a braille spinner glyph
    expect(f).toContain('…');
  });
});
