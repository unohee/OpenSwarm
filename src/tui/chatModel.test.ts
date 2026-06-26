import { describe, it, expect } from 'vitest';
import { chatReducer, initialChatState, parseInput, matchSlash } from './chatModel.js';

describe('chatReducer (EPIC INT-1813 S4)', () => {
  it('appends user and system lines', () => {
    let s = chatReducer(initialChatState, { type: 'user', content: 'hi' });
    s = chatReducer(s, { type: 'system', content: 'note' });
    expect(s.history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'note' },
    ]);
  });

  it('accumulates streaming chunks then commits to an assistant line', () => {
    let s = chatReducer(initialChatState, { type: 'stream', chunk: 'he' });
    s = chatReducer(s, { type: 'stream', chunk: 'llo' });
    expect(s.streaming).toBe('hello');
    s = chatReducer(s, { type: 'commit' });
    expect(s.streaming).toBeNull();
    expect(s.history.at(-1)).toEqual({ role: 'assistant', content: 'hello' });
  });

  it('commit with nothing streaming is a no-op', () => {
    const s = chatReducer(initialChatState, { type: 'commit' });
    expect(s).toBe(initialChatState);
  });

  it('clear resets to the initial state', () => {
    const s = chatReducer({ history: [{ role: 'user', content: 'x' }], streaming: 'y' }, { type: 'clear' });
    expect(s).toEqual(initialChatState);
  });
});

describe('parseInput', () => {
  it('classifies free chat', () => {
    expect(parseInput('  hello world ')).toEqual({ kind: 'chat', text: 'hello world' });
  });
  it('classifies a bare command', () => {
    expect(parseInput('/clear')).toEqual({ kind: 'command', name: '/clear', args: '' });
  });
  it('classifies a command with args', () => {
    expect(parseInput('/model gpt-5.2')).toEqual({ kind: 'command', name: '/model', args: 'gpt-5.2' });
  });
  it('returns null for empty input', () => {
    expect(parseInput('   ')).toBeNull();
  });
});

describe('matchSlash', () => {
  it('prefix-matches command names', () => {
    expect(matchSlash('/m').map((c) => c.name)).toEqual(['/model']);
    expect(matchSlash('/').length).toBeGreaterThan(1);
  });
  it('does not match plain chat or once an argument is being typed', () => {
    expect(matchSlash('hello')).toEqual([]);
    expect(matchSlash('/model gpt')).toEqual([]);
  });
});
