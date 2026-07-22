import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from './App.js';

// Input handling is async (ink processes stdin on the next ticks).
const tick = () => new Promise((r) => setTimeout(r, 40));

describe('Ink shell (EPIC INT-1813 S3/S4/S5)', () => {
  it('renders status bar, tab strip, and the default Chat panel', () => {
    const { lastFrame } = render(<App version="9.9.9" provider="codex" model="gpt-5.2-codex" />);
    const f = lastFrame()!;
    expect(f).toContain('OpenSwarm v9.9.9');
    expect(f).toContain('codex:gpt-5.2-codex');
    expect(f).toContain('1:Chat');
    expect(f).toContain('2:Pipeline');
    expect(f).toContain('7:Logs');
    expect(f).toContain('type a message'); // chat input placeholder
  });

  it('switches tab on a digit key (from a non-chat tab)', async () => {
    const { lastFrame, stdin } = render(<App version="1.0.0" initialTab={1} />); // start on Pipeline
    stdin.write('7'); // 7 → Logs (distinct placeholder text)
    await tick();
    expect(lastFrame()).toContain('stream logs');
  });

  it('renders the Pipeline panel (idle, no port) at initialTab 1', () => {
    const f = render(<App initialTab={1} />).lastFrame()!;
    expect(f).toContain('Pipeline stages');
    expect(f).toContain('daemon port unknown');
  });

  it('renders a monitor panel (idle, no port) on the Projects tab', () => {
    const f = render(<App initialTab={2} />).lastFrame()!; // Projects
    expect(f).toContain('daemon port unknown');
  });

  it('cycles forward with Tab, wrapping from the last tab back to Chat', async () => {
    const { lastFrame, stdin } = render(<App initialTab={6} />); // start at Logs
    expect(lastFrame()).toContain('stream logs');
    stdin.write('\t'); // Tab → wrap forward to Chat
    await tick();
    expect(lastFrame()).toContain('type a message'); // chat input back
  });

  it('honors an initialTab', () => {
    const { lastFrame } = render(<App initialTab={6} />); // Logs
    expect(lastFrame()).toContain('stream logs');
  });

  it.each([-1, 7, Number.NaN])('normalizes invalid initialTab %s', (initialTab) => {
    expect(render(<App initialTab={initialTab} />).lastFrame()).toContain('type a message');
  });
});
