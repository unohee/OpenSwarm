import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from './App.js';

// Proves the full JSX build chain (INT-1934 / EPIC INT-1813 S1): a .tsx component
// compiles, Ink renders it, and ink-testing-library can assert on the output.
describe('Ink scaffold (EPIC INT-1813 S1)', () => {
  it('renders the OpenSwarm header with a version', () => {
    const { lastFrame } = render(<App version="9.9.9" />);
    expect(lastFrame()).toContain('OpenSwarm');
    expect(lastFrame()).toContain('v9.9.9');
  });

  it('renders a scaffold label when no version is given', () => {
    const { lastFrame } = render(<App />);
    expect(lastFrame()).toContain('OpenSwarm');
    expect(lastFrame()).toContain('scaffold');
  });
});
