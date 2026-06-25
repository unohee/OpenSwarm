// ============================================
// OpenSwarm - Agentic Loop history compaction tests
// Regression guard for the worker-failure bug: over-eager compaction used to
// strip everything but the last assistant block every turn, so the model lost
// the files it had just read and looped 3-4 times. These tests pin the VEGA-style
// behaviour: keep recent blocks intact, never leave orphan tool messages.
// ============================================

import { describe, it, expect } from 'vitest';
import { compactPriorTurns, toolCallKey, allToolCallsSeen, shouldNudgeReadLoop, READ_LOOP_NUDGE_AT, type ChatMessage } from './agenticLoop.js';
import type { ToolCall } from './tools.js';

describe('progress-based stop helpers', () => {
  const mk = (name: string, args: string): ToolCall => ({ id: 'x', function: { name, arguments: args } });

  it('toolCallKey combines name + args', () => {
    expect(toolCallKey(mk('read_file', '{"path":"a"}'))).toBe('read_file:{"path":"a"}');
  });

  it('an empty turn (no tool calls) is not a stall', () => {
    expect(allToolCallsSeen([], new Set())).toBe(false);
  });

  it('all calls already seen → stalled turn', () => {
    const seen = new Set(['read_file:{"path":"a"}']);
    expect(allToolCallsSeen([mk('read_file', '{"path":"a"}')], seen)).toBe(true);
  });

  it('any new call (e.g. different path) → progress, not a stall', () => {
    const seen = new Set(['read_file:{"path":"a"}']);
    expect(allToolCallsSeen([mk('read_file', '{"path":"a"}'), mk('read_file', '{"path":"b"}')], seen)).toBe(false);
  });
});

/** Build a representative tool-using history: system + user + N (assistant→tool) rounds. */
function buildHistory(rounds: number): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a worker.' },
    { role: 'user', content: 'Do the task.' },
  ];
  for (let i = 0; i < rounds; i++) {
    messages.push({
      role: 'assistant',
      content: `Step ${i}: reading file`,
      tool_calls: [{
        id: `call_${i}`,
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: `src/file${i}.ts` }) },
      }],
    });
    messages.push({
      role: 'tool',
      tool_call_id: `call_${i}`,
      content: `contents of file${i}`,
    });
  }
  return messages;
}

/** Every tool message must immediately follow an assistant carrying its tool_call_id. */
function hasNoOrphanToolMessages(messages: ChatMessage[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    const prev = messages[i - 1];
    if (!prev || prev.role !== 'assistant' || !prev.tool_calls) return false;
    const ids = prev.tool_calls.map((tc) => tc.id);
    if (!ids.includes(m.tool_call_id)) return false;
  }
  return true;
}

describe('compactPriorTurns', () => {
  it('keeps the most recent keepRecent messages verbatim', () => {
    const messages = buildHistory(10); // 2 header + 20 round msgs = 22
    const before = messages.slice(-4).map((m) => JSON.stringify(m));

    compactPriorTurns(messages, 4);

    const after = messages.slice(-4).map((m) => JSON.stringify(m));
    expect(after).toEqual(before);
  });

  it('preserves the system + user header', () => {
    const messages = buildHistory(8);
    compactPriorTurns(messages, 4);

    expect(messages[0]).toEqual({ role: 'system', content: 'You are a worker.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Do the task.' });
  });

  it('never leaves an orphan tool message after compaction', () => {
    const messages = buildHistory(10);
    compactPriorTurns(messages, 5);
    expect(hasNoOrphanToolMessages(messages)).toBe(true);
  });

  it('replaces old rounds with a single [Prior turns compacted] summary', () => {
    const messages = buildHistory(10);
    compactPriorTurns(messages, 4);

    const summaries = messages.filter(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('[Prior turns compacted]'),
    );
    expect(summaries).toHaveLength(1);
    // The summary must sit right after the header, before the preserved tail.
    expect(messages[2].role).toBe('assistant');
    expect((messages[2] as { content: string }).content).toContain('[Prior turns compacted]');
  });

  it('shrinks total message count (actually compacts)', () => {
    const messages = buildHistory(10);
    const originalLen = messages.length;
    compactPriorTurns(messages, 4);
    expect(messages.length).toBeLessThan(originalLen);
  });

  it('is a no-op when nothing is old enough to compact', () => {
    // keepRecent larger than the whole body → boundary collapses to header, no change.
    const messages = buildHistory(2); // 2 header + 4 body = 6
    const snapshot = messages.map((m) => JSON.stringify(m));
    compactPriorTurns(messages, 10);
    expect(messages.map((m) => JSON.stringify(m))).toEqual(snapshot);
  });

  it('absorbs an existing summary instead of nesting summaries', () => {
    const messages = buildHistory(12);
    compactPriorTurns(messages, 4); // first pass creates a summary
    compactPriorTurns(messages, 4); // second pass should fold it in, not nest

    const summaries = messages.filter(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('[Prior turns compacted]'),
    );
    expect(summaries.length).toBeLessThanOrEqual(1);
  });
});

describe('shouldNudgeReadLoop — early read-loop nudge (ported 8a1420f)', () => {
  it('nudges once past the early turn with zero edits and budget left', () => {
    expect(shouldNudgeReadLoop(0, 0, 3, READ_LOOP_NUDGE_AT)).toBe(true);
    expect(shouldNudgeReadLoop(0, 0, 3, READ_LOOP_NUDGE_AT + 5)).toBe(true);
  });
  it('does NOT nudge before the early turn', () => {
    expect(shouldNudgeReadLoop(0, 0, 3, READ_LOOP_NUDGE_AT - 1)).toBe(false);
  });
  it('does NOT nudge once an edit has happened', () => {
    expect(shouldNudgeReadLoop(1, 0, 3, READ_LOOP_NUDGE_AT + 5)).toBe(false);
  });
  it('stops nudging once the budget is exhausted', () => {
    expect(shouldNudgeReadLoop(0, 3, 3, READ_LOOP_NUDGE_AT + 5)).toBe(false);
  });
});
