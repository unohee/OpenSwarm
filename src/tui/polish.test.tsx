import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ContextBar } from './components/ContextBar.js';
import { ChatInput } from './components/ChatInput.js';
import { ChatLog } from './components/ChatLog.js';
import type { ChatLine } from './chatModel.js';

describe('ContextBar (INT-1943)', () => {
  it('renders the wordmark and provider/model · cwd · branch', () => {
    const f = render(
      <ContextBar version="1.2.3" provider="codex" model="gpt-5.2-codex" cwd="/home/u/dev/app" branch="main" />,
    ).lastFrame()!;
    expect(f).toContain('OpenSwarm');
    expect(f).toContain('v1.2.3');
    expect(f).toContain('codex:gpt-5.2-codex');
    expect(f).toContain('app'); // basename of cwd
    expect(f).toContain('main'); // git branch
  });
});

describe('ChatInput (INT-1943)', () => {
  const noop = () => {};
  it('shows the placeholder when empty', () => {
    expect(render(<ChatInput value="" active onChange={noop} onSubmit={noop} />).lastFrame()).toContain('type a message');
  });
  it('shows a working spinner state when busy', () => {
    expect(render(<ChatInput value="" active busy onChange={noop} onSubmit={noop} />).lastFrame()).toContain('working');
  });
  it('renders the typed value', () => {
    expect(render(<ChatInput value="hello" active onChange={noop} onSubmit={noop} />).lastFrame()).toContain('hello');
  });
});

describe('ChatLog (INT-1943)', () => {
  it('labels the assistant as openswarm and renders markdown content', () => {
    const history: ChatLine[] = [{ role: 'assistant', content: 'use **bold** here' }];
    const f = render(<ChatLog history={history} streaming={null} />).lastFrame()!;
    expect(f).toContain('openswarm');
    expect(f).toContain('bold');
  });
  it('shows tool activity + an animated loading line while busy', () => {
    const f = render(<ChatLog history={[]} streaming={''} activity={['read_file auth.ts']} busy />).lastFrame()!;
    expect(f).toContain('read_file auth.ts');
    expect(f).toMatch(/…/); // WorkingIndicator's cycling loading line
  });
});
