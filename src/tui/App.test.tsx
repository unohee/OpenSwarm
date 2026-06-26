import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from './App.js';

// Input handling is async (ink processes stdin on the next ticks).
const tick = () => new Promise((r) => setTimeout(r, 40));

describe('Ink shell (EPIC INT-1813 S3)', () => {
  it('renders status bar, tab strip, and the default Chat panel', () => {
    const { lastFrame } = render(<App version="9.9.9" provider="codex" model="gpt-5.2-codex" />);
    const f = lastFrame()!;
    expect(f).toContain('OpenSwarm v9.9.9');
    expect(f).toContain('codex:gpt-5.2-codex');
    expect(f).toContain('1:Chat');
    expect(f).toContain('6:Logs');
    expect(f).toContain('Chat — panel');
  });

  it('switches tab on a digit key', async () => {
    const { lastFrame, stdin } = render(<App version="1.0.0" />);
    stdin.write('3');
    await tick();
    expect(lastFrame()).toContain('Tasks — panel');
  });

  it('cycles forward with Tab, wrapping past the last tab', async () => {
    const { lastFrame, stdin } = render(<App initialTab={5} />); // start at Logs
    expect(lastFrame()).toContain('Logs — panel');
    stdin.write('\t'); // Tab → wrap forward to Chat
    await tick();
    expect(lastFrame()).toContain('Chat — panel');
  });

  it('honors an initialTab', () => {
    const { lastFrame } = render(<App initialTab={4} />);
    expect(lastFrame()).toContain('Issues — panel');
  });
});
