import { describe, it, expect, vi } from 'vitest';
import { CodexCliAdapter, coerceCodexModel } from './codex.js';

describe('CodexCliAdapter', () => {
  const adapter = new CodexCliAdapter();

  it('builds a codex exec command with sandbox json mode', () => {
    const { command } = adapter.buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'gpt-5-codex',
    });

    expect(command).toContain('codex exec');
    expect(command).toContain('--json');
    // --full-auto was deprecated in codex 0.137 → --sandbox workspace-write (INT-1699)
    expect(command).toContain('--sandbox workspace-write');
    expect(command).not.toContain('--full-auto');
    expect(command).toContain('--skip-git-repo-check');
    expect(command).toContain("-m 'gpt-5-codex'");
  });

  it('substitutes a claude model with the codex default and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { command } = adapter.buildCommand({
        prompt: '/tmp/prompt.txt',
        cwd: '/tmp/project',
        model: 'claude-sonnet-4-20250514',
      });
      // Should not pass the claude model through to the codex CLI.
      expect(command).not.toContain('claude-sonnet');
      expect(command).toContain("-m 'gpt-5-codex'");
      // Warning emitted at least once for this model name.
      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('claude-sonnet-4-20250514'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('coerceCodexModel passes OpenAI model names through unchanged', () => {
    expect(coerceCodexModel('gpt-5-codex')).toBe('gpt-5-codex');
    expect(coerceCodexModel('o3')).toBe('o3');
    expect(coerceCodexModel('gpt-4o')).toBe('gpt-4o');
  });

  it('coerceCodexModel rewrites every claude-* variant', () => {
    expect(coerceCodexModel('claude-opus-4-6')).toBe('gpt-5-codex');
    expect(coerceCodexModel('claude-haiku-4-5-20251001')).toBe('gpt-5-codex');
    expect(coerceCodexModel('Claude-Sonnet-4')).toBe('gpt-5-codex');
  });

  it('parses worker output from codex json events', () => {
    const raw = {
      exitCode: 0,
      stdout: [
        '{"type":"thread.started","thread_id":"1"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"```json\\n{\\"success\\":true,\\"summary\\":\\"Done\\",\\"filesChanged\\":[\\"src/a.ts\\"],\\"commands\\":[\\"npm test\\"]}\\n```"}}',
      ].join('\n'),
      stderr: '',
      durationMs: 1,
    };

    const result = adapter.parseWorkerOutput(raw);
    expect(result.success).toBe(true);
    expect(result.summary).toBe('Done');
    expect(result.filesChanged).toEqual(['src/a.ts']);
    expect(result.commands).toEqual(['npm test']);
  });

  it('parses reviewer output from codex json events', () => {
    const raw = {
      exitCode: 0,
      stdout: [
        '{"type":"thread.started","thread_id":"1"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"```json\\n{\\"decision\\":\\"revise\\",\\"feedback\\":\\"Fix tests\\",\\"issues\\":[\\"Missing test\\"],\\"suggestions\\":[\\"Add unit test\\"]}\\n```"}}',
      ].join('\n'),
      stderr: '',
      durationMs: 1,
    };

    const result = adapter.parseReviewerOutput(raw);
    expect(result.decision).toBe('revise');
    expect(result.feedback).toBe('Fix tests');
    expect(result.issues).toEqual(['Missing test']);
    expect(result.suggestions).toEqual(['Add unit test']);
  });

  it('streams agent messages into live log lines', () => {
    const logs: string[] = [];
    const remainder = adapter.parseStreamingChunk?.([
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"reasoning","text":"Checking repository state"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"## Plan\\n- first step\\n\\nDone"}}',
      '{"type":"turn.completed"}',
      '',
    ].join('\n'), (line) => logs.push(line));

    expect(remainder).toBe('');
    expect(logs).toEqual([
      '───',
      'Codex turn started',
      '▸ Checking repository state',
      '',
      '■ Plan',
      '  - first step',
      '',
      'Done',
      'Codex turn completed',
    ]);
  });

  it('preserves partial codex json chunks until complete', () => {
    const logs: string[] = [];
    const chunk1 = '{"type":"item.completed","item":{"type":"agent_message","text":"Hello';
    const chunk2 = ' world"}}\n';

    const remainder1 = adapter.parseStreamingChunk?.(chunk1, (line) => logs.push(line));
    const remainder2 = adapter.parseStreamingChunk?.(chunk2, (line) => logs.push(line), remainder1);

    expect(remainder1).toBe(chunk1);
    expect(remainder2).toBe('');
    expect(logs).toEqual(['Hello world']);
  });
});
