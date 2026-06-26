import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render } from 'ink-testing-library';
import { ChatLog } from './components/ChatLog.js';
import { CommandPalette } from './components/CommandPalette.js';
import { ChatInput } from './components/ChatInput.js';
import { matchSlash, type ChatLine } from './chatModel.js';

const tick = () => new Promise((r) => setTimeout(r, 40));

describe('ChatLog', () => {
  it('renders finalized history and the live streaming line', () => {
    const history: ChatLine[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const f = render(<ChatLog history={history} streaming={'typing…'} />).lastFrame()!;
    expect(f).toContain('hello');
    expect(f).toContain('hi there');
    expect(f).toContain('typing…');
  });

  it('accumulates every message (no <Static> — persists under full-screen)', () => {
    // Regression: messages used to vanish because <Static> is wiped by the
    // alt-screen full-frame redraw. They must all stay in the render tree.
    const history: ChatLine[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' },
    ];
    const f = render(<ChatLog history={history} streaming={null} />).lastFrame()!;
    for (const msg of ['first question', 'first answer', 'second question', 'second answer']) {
      expect(f).toContain(msg);
    }
  });
});

describe('CommandPalette', () => {
  it('lists matching commands and nothing when empty', () => {
    expect(render(<CommandPalette matches={matchSlash('/m')} />).lastFrame()).toContain('/model');
    expect(render(<CommandPalette matches={[]} />).lastFrame()).toBe('');
  });

  it('marks the selected row with a pointer (INT-1959)', () => {
    const f = render(<CommandPalette matches={matchSlash('/')} selectedIndex={1} />).lastFrame()!;
    expect(f).toContain('❯');
  });
});

describe('ChatInput', () => {
  function Harness({ onSubmit }: { onSubmit: (v: string) => void }) {
    const [v, setV] = useState('');
    return <ChatInput value={v} active busy={false} onChange={setV} onSubmit={onSubmit} />;
  }

  it('echoes typed characters and submits on Enter', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = render(<Harness onSubmit={onSubmit} />);
    stdin.write('hi'); // ink delivers the chunk as one input event
    await tick();
    expect(lastFrame()).toContain('hi');
    stdin.write('\r'); // Enter
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hi');
  });

  it('collapses a doubled multibyte keystroke event to one (INT-1964)', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = render(<Harness onSubmit={onSubmit} />);
    stdin.write('이이'); // mobile-SSH delivers the doubled syllable as one event
    await tick();
    expect(lastFrame()).toContain('이');
    expect(lastFrame()).not.toContain('이이');
  });

  it('routes nav/select keys to the palette when open, not submit (INT-1959)', async () => {
    const onSubmit = vi.fn();
    const onPaletteMove = vi.fn();
    const onPaletteSelect = vi.fn();
    const { stdin } = render(
      <ChatInput
        value="/m"
        active
        busy={false}
        onChange={() => {}}
        onSubmit={onSubmit}
        paletteOpen
        onPaletteMove={onPaletteMove}
        onPaletteSelect={onPaletteSelect}
      />,
    );
    stdin.write('[B'); // down arrow
    await tick();
    expect(onPaletteMove).toHaveBeenCalledWith(1);
    stdin.write('\r'); // Enter selects, does not submit
    await tick();
    expect(onPaletteSelect).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
