import { describe, it, expect } from 'vitest';
import { CodexCliAdapter } from './codex.js';

describe('CodexCliAdapter', () => {
  const adapter = new CodexCliAdapter();

  it('builds a codex exec command with full-auto json mode', () => {
    const { command } = adapter.buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'gpt-5-codex',
    });

    expect(command).toContain('codex exec');
    expect(command).toContain('--json');
    expect(command).toContain('--full-auto');
    expect(command).toContain('--skip-git-repo-check');
    expect(command).toContain("-m 'gpt-5-codex'");
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
