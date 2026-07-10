// Purpose: close coverage gaps left by goalCommand.test.ts — the word-count
// complexity branch in judgeGoalComplexity (>25 words) and the real
// defaultPursue implementation, which goalCommand.test.ts never exercises
// because every routing test injects a `pursue` stub via GoalCommandDeps.
// chatSession/chatBackend are mocked so nothing calls a real model/adapter.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlanIO } from './planCommand.js';

const callChatModel = vi.fn();
const loadDefaultProvider = vi.fn();
const getDefaultChatModel = vi.fn();

vi.mock('./chatSession.js', () => ({
  callChatModel: (...args: unknown[]) => callChatModel(...args),
  loadDefaultProvider: (...args: unknown[]) => loadDefaultProvider(...args),
}));

vi.mock('./chatBackend.js', () => ({
  getDefaultChatModel: (...args: unknown[]) => getDefaultChatModel(...args),
}));

const { judgeGoalComplexity, runGoalCommand, GOAL_PURSUIT_MAX_TURNS } = await import('./goalCommand.js');

const io = (lines: string[] = []): PlanIO => ({
  print: (l) => lines.push(l),
  confirm: async () => 'yes',
  promptText: async () => '',
});

describe('judgeGoalComplexity word-count branch', () => {
  it('flags a goal as complex purely on length (>25 words, no other signal)', () => {
    // Exactly 26 plain words, one sentence, no keywords/conjunctions/lists —
    // isolates the `words > 25` branch (score += 2) from every other signal.
    const goal = Array.from({ length: 26 }, (_, i) => `word${i}`).join(' ');
    expect(judgeGoalComplexity(goal)).toBe('complex');
  });

  it('does not flag a goal of 25 words or fewer on length alone', () => {
    const goal = Array.from({ length: 13 }, (_, i) => `word${i}`).join(' ');
    // 13 words: > 12 so +1, but not > 25 — score of 1 stays simple.
    expect(judgeGoalComplexity(goal)).toBe('simple');
  });
});

describe('defaultPursue (real simple-goal pursuit path)', () => {
  beforeEach(() => {
    callChatModel.mockReset();
    loadDefaultProvider.mockReset();
    getDefaultChatModel.mockReset();
    loadDefaultProvider.mockReturnValue('codex');
    getDefaultChatModel.mockReturnValue('default-model');
  });

  it('falls back to the default provider/model/turn-budget and prints streamed + tool-log output', async () => {
    callChatModel.mockImplementation(async (
      _prompt: string,
      _provider: string,
      _model: string,
      onStream: (t: string) => void,
      onToolLog?: (l: string) => void,
    ) => {
      onStream('partial result text');
      onToolLog?.('ran: npm test');
      return { response: 'partial result text', sessionId: 's1', cost: 0, tokens: 0 };
    });

    const lines: string[] = [];
    const complexity = await runGoalCommand('do a small thing', io(lines), {}, { judge: () => 'simple' });

    expect(complexity).toBe('simple');
    expect(loadDefaultProvider).toHaveBeenCalledOnce();
    expect(getDefaultChatModel).toHaveBeenCalledWith('codex');
    expect(callChatModel).toHaveBeenCalledOnce();
    const [prompt, provider, model, , , maxTurns, signal, projectPath] = callChatModel.mock.calls[0];
    expect(prompt).toContain('do a small thing');
    expect(provider).toBe('codex');
    expect(model).toBe('default-model');
    expect(maxTurns).toBe(GOAL_PURSUIT_MAX_TURNS);
    expect(signal).toBeUndefined();
    expect(projectPath).toBeUndefined();
    // Both the tool-log bridge and the final streamed-text print happened.
    expect(lines).toContain('ran: npm test');
    expect(lines).toContain('partial result text');
  });

  it('honors explicit provider/model/maxTurns/signal/projectPath and skips the final print when nothing streamed', async () => {
    callChatModel.mockImplementation(async () => ({ response: '', sessionId: '', cost: 0, tokens: 0 }));
    const controller = new AbortController();

    const lines: string[] = [];
    await runGoalCommand(
      'small explicit thing',
      io(lines),
      { provider: 'claude', model: 'opus', maxTurns: 5, signal: controller.signal, projectPath: '/repo' },
      { judge: () => 'simple' },
    );

    expect(loadDefaultProvider).not.toHaveBeenCalled();
    expect(getDefaultChatModel).not.toHaveBeenCalled();
    const [, provider, model, , , maxTurns, signal, projectPath] = callChatModel.mock.calls[0];
    expect(provider).toBe('claude');
    expect(model).toBe('opus');
    expect(maxTurns).toBe(5);
    expect(signal).toBe(controller.signal);
    expect(projectPath).toBe('/repo');
    // No text streamed (empty response) — only the routing banner line is printed.
    expect(lines.some(l => l.includes('Simple goal'))).toBe(true);
    expect(lines).not.toContain('');
  });
});
