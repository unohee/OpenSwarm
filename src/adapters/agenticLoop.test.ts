// ============================================
// OpenSwarm - Agentic Loop history compaction tests
// Regression guard for the worker-failure bug: over-eager compaction used to
// strip everything but the last assistant block every turn, so the model lost
// the files it had just read and looped 3-4 times. These tests pin the VEGA-style
// behaviour: keep recent blocks intact, never leave orphan tool messages.
// ============================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compactPriorTurns, toolCallKey, allToolCallsSeen, shouldNudgeReadLoop, READ_LOOP_NUDGE_AT, runAgenticLoop, loopResultToCliResult, type ChatMessage, type AgenticLoopResult } from './agenticLoop.js';
import type { ToolCall } from './tools.js';

/** Scripted API response carrying a single tool call. */
const toolCallResp = (id: string, name: string, args: object) => ({
  choices: [{
    message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] },
    finish_reason: 'tool_calls',
  }],
});
/** Scripted API response with no tool calls (model tries to finish). */
const finalResp = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

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

describe('runAgenticLoop nudge budgets (INT-1925)', () => {
  it('read-loop nudges do not drain the no-edit guard budget', async () => {
    const logs: string[] = [];
    let call = 0;
    // Read a different (nonexistent) file each turn so the no-progress stall
    // detector never fires; zero edits throughout. After the read-loop nudge
    // fires (turn >= READ_LOOP_NUDGE_AT), the model tries to finish with no edits.
    const callApi = async () => {
      call++;
      if (call <= READ_LOOP_NUDGE_AT + 1) {
        return toolCallResp(`c${call}`, 'read_file', { path: `nope${call}.ts` });
      }
      return finalResp('analysis only');
    };
    await runAgenticLoop({
      prompt: 'fix the bug', cwd: process.cwd(), model: 'test', callApi,
      nudgeMaxOnNoEdit: 1, maxTurns: 30, webTools: false,
      onLog: (l) => logs.push(l),
    });
    // The read-loop nudge fired AND, with a separate counter, the finish-turn
    // no-edit guard STILL had budget to fire afterwards. (Shared-counter bug
    // would have left the guard exhausted → no "No-edit guard" log.)
    expect(logs.some((l) => l.includes('Read-loop nudge'))).toBe(true);
    expect(logs.some((l) => l.includes('No-edit guard'))).toBe(true);
  });
});

describe('runAgenticLoop timeout contract', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('treats timeoutMs=0 as no deadline, matching spawnCli', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    let calls = 0;
    const callApi = async () => {
      calls++;
      return finalResp('done');
    };

    const res = await runAgenticLoop({
      prompt: 'x',
      cwd: process.cwd(),
      model: 'test',
      callApi,
      webTools: false,
      timeoutMs: 0,
      maxTurns: 1,
    });

    expect(calls).toBe(1);
    expect(res.text).toBe('done');
  });
});

describe('runAgenticLoop tool exposure options', () => {
  it('hides search_memory when memoryTools=false without disabling file tools', async () => {
    let toolNames: string[] = [];

    await runAgenticLoop({
      prompt: 'x',
      cwd: process.cwd(),
      model: 'test',
      webTools: false,
      memoryTools: false,
      maxTurns: 1,
      callApi: async (_messages, tools) => {
        toolNames = tools.map((tool) => tool.function.name);
        return finalResp('done');
      },
    });

    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('bash');
    expect(toolNames).not.toContain('search_memory');
  });
});

describe('runAgenticLoop read cache vs compaction (INT-1929)', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aloop-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  /** Drive two identical reads of f.txt, capturing the tool result the model sees each call. */
  const runTwoReads = async (opts: { compactAfterMessages: number; compactTokenThreshold?: number; keepRecentMessages?: number }) => {
    await fs.writeFile(path.join(tmp, 'f.txt'), 'ALPHA_CONTENT', 'utf-8');
    const seen: string[] = [];
    let call = 0;
    const callApi = async (messages: ChatMessage[]) => {
      const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
      if (lastTool && lastTool.role === 'tool') seen.push(lastTool.content);
      call++;
      if (call <= 2) return toolCallResp(`c${call}`, 'read_file', { path: 'f.txt' });
      return finalResp('done');
    };
    await runAgenticLoop({
      prompt: 'inspect f', cwd: tmp, model: 'test', callApi,
      webTools: false, maxTurns: 10, ...opts,
    });
    return seen;
  };

  it('returns a STUB on an in-loop re-read when no compaction happens', async () => {
    const seen = await runTwoReads({ compactAfterMessages: 999 });
    expect(seen.some((c) => c.includes('ALPHA_CONTENT'))).toBe(true);
    expect(seen.some((c) => c.includes('already read'))).toBe(true);
  });

  it('clears the read cache on compaction so a re-read returns full content again (INT-1929)', async () => {
    // Force the compaction branch every eligible turn (low thresholds), but keep
    // recent messages verbatim so the assertion sees the real re-read result.
    const seen = await runTwoReads({ compactAfterMessages: 2, compactTokenThreshold: 1, keepRecentMessages: 999 });
    expect(seen.filter((c) => c.includes('ALPHA_CONTENT')).length).toBeGreaterThanOrEqual(2);
    expect(seen.some((c) => c.includes('already read'))).toBe(false);
  });
});

describe('loopResultToCliResult costInfo (INT-2508)', () => {
  it('carries loop-measured tokens/duration as costInfo with zero (subscription) cost', () => {
    const loop: AgenticLoopResult = {
      text: 'done',
      toolCallCount: 3,
      apiCallCount: 4,
      totalTokens: 12000,
      inputTokens: 10000,
      outputTokens: 2000,
      cachedTokens: 8000,
      durationMs: 45200,
      executedCommands: ['npm test'],
    };
    const cli = loopResultToCliResult(loop);
    expect(cli.costInfo).toEqual({
      costUsd: 0,
      inputTokens: 10000,
      outputTokens: 2000,
      cacheReadTokens: 8000,
      cacheCreationTokens: 0,
      durationMs: 45200,
    });
    expect(cli.stdout).toBe('done');
    expect(cli.executedCommands).toEqual(['npm test']);
  });
});
