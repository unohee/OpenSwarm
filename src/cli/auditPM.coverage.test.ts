// Coverage companion for auditPM.ts — the base auditPM.test.ts only exercises
// buildSynthesisPrompt/parseSynthesisOutput and synthesizeAuditIssues' early
// "too few follow-ups" guard. This file drives the actual adapter-call path
// (success, non-zero exit, and thrown-error branches), mocking the adapter
// layer so no real CLI process is spawned.
import { describe, it, expect, vi } from 'vitest';
import { synthesizeAuditIssues, parseSynthesisOutput } from './auditPM.js';
import type { RecommendedAction } from '../agents/agentPair.js';

// auditPM.ts imports these as STATIC imports (unlike reviewCommand.ts's dynamic
// `await import(...)`), so the vi.mock factory below runs during hoisting —
// before any plain `const` in this file would be initialized. vi.hoisted()
// creates the vi.fn()s in that same hoisted phase so the factory can see them.
const { getAdapterMock, spawnCliMock } = vi.hoisted(() => ({
  getAdapterMock: vi.fn(),
  spawnCliMock: vi.fn(),
}));
vi.mock('../adapters/index.js', () => ({
  getAdapter: getAdapterMock,
  spawnCli: spawnCliMock,
}));

vi.mock('../locale/index.js', () => ({
  getPrompts: () => ({ systemPrompt: 'test system prompt' }),
}));

// > MIN_ACTIONS_TO_SYNTHESIZE (3) so synthesizeAuditIssues actually calls the adapter.
const actions: RecommendedAction[] = [
  { type: 'refactor', title: 'extract shared parser', location: 'src/a.ts:10' },
  { type: 'test', title: 'cover error path', location: 'src/b.ts:42' },
  { type: 'fix', title: 'handle null input' },
  { type: 'chore', title: 'update deps' },
];

describe('synthesizeAuditIssues adapter path (INT-2225)', () => {
  it('parses the adapter stdout into synthesized issues on a clean exit', async () => {
    getAdapterMock.mockReturnValueOnce({ name: 'stub-adapter' });
    spawnCliMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout:
        '```json\n' +
        JSON.stringify({
          issues: [{ title: 'refactor(x): consolidate — why', priority: 2, items: ['a'], description: 'd' }],
        }) +
        '\n```',
      stderr: '',
    });

    const out = await synthesizeAuditIssues(actions, { cwd: '/repo', repoName: 'OpenSwarm' });

    expect(out).toEqual([{ title: 'refactor(x): consolidate — why', priority: 2, items: ['a'], description: 'd' }]);
    expect(getAdapterMock).toHaveBeenCalledWith(undefined);
    expect(spawnCliMock).toHaveBeenCalledWith(
      { name: 'stub-adapter' },
      expect.objectContaining({ cwd: '/repo', timeoutMs: 600_000, maxTurns: 10, systemPrompt: 'test system prompt' }),
    );
  });

  it('passes the adapter override through to getAdapter', async () => {
    getAdapterMock.mockReturnValueOnce({ name: 'codex' });
    spawnCliMock.mockResolvedValueOnce({ exitCode: 0, stdout: '```json\n{"issues":[]}\n```', stderr: '' });

    await synthesizeAuditIssues(actions, { cwd: '/repo', repoName: 'OpenSwarm', adapter: 'codex' });

    expect(getAdapterMock).toHaveBeenCalledWith('codex');
  });

  it('returns [] and logs when the adapter exits non-zero with no stdout', async () => {
    getAdapterMock.mockReturnValueOnce({ name: 'stub-adapter' });
    spawnCliMock.mockResolvedValueOnce({ exitCode: 1, stdout: '   ', stderr: 'adapter crashed hard' });
    const logs: string[] = [];

    const out = await synthesizeAuditIssues(actions, { cwd: '/repo', repoName: 'OpenSwarm', onLog: (l) => logs.push(l) });

    expect(out).toEqual([]);
    expect(logs.join('\n')).toContain('Synthesis adapter exited 1');
    expect(logs.join('\n')).toContain('adapter crashed hard');
  });

  it('reports "no output" when a non-zero exit has neither stdout nor stderr', async () => {
    getAdapterMock.mockReturnValueOnce({ name: 'stub-adapter' });
    spawnCliMock.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    const logs: string[] = [];

    await synthesizeAuditIssues(actions, { cwd: '/repo', repoName: 'OpenSwarm', onLog: (l) => logs.push(l) });

    expect(logs.join('\n')).toContain('no output');
  });

  it('still parses stdout when the adapter exits non-zero but produced output anyway', async () => {
    getAdapterMock.mockReturnValueOnce({ name: 'stub-adapter' });
    spawnCliMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '```json\n' + JSON.stringify({ issues: [{ title: 'fix(y): z', priority: 1 }] }) + '\n```',
      stderr: 'warning but recovered',
    });

    const out = await synthesizeAuditIssues(actions, { cwd: '/repo', repoName: 'OpenSwarm' });

    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('fix(y): z');
  });

  it('catches a thrown error from spawnCli and returns []', async () => {
    getAdapterMock.mockReturnValueOnce({ name: 'stub-adapter' });
    spawnCliMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const logs: string[] = [];

    const out = await synthesizeAuditIssues(actions, { cwd: '/repo', repoName: 'OpenSwarm', onLog: (l) => logs.push(l) });

    expect(out).toEqual([]);
    expect(logs.join('\n')).toContain('Synthesis failed: ECONNREFUSED');
  });

  it('catches a thrown non-Error value from getAdapter and stringifies it', async () => {
    getAdapterMock.mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'adapter not found';
    });
    const logs: string[] = [];

    const out = await synthesizeAuditIssues(actions, { cwd: '/repo', repoName: 'OpenSwarm', onLog: (l) => logs.push(l) });

    expect(out).toEqual([]);
    expect(logs.join('\n')).toContain('Synthesis failed: adapter not found');
  });

  it('is a no-op (no logs) when onLog is not supplied and the adapter fails', async () => {
    getAdapterMock.mockReturnValueOnce({ name: 'stub-adapter' });
    spawnCliMock.mockRejectedValueOnce(new Error('boom'));
    await expect(synthesizeAuditIssues(actions, { cwd: '/repo', repoName: 'OpenSwarm' })).resolves.toEqual([]);
  });
});

describe('parseSynthesisOutput — skips non-object/null entries in issues[]', () => {
  it('drops null and primitive entries but keeps valid objects', () => {
    const stdout =
      '```json\n' +
      JSON.stringify({
        issues: [null, 'not an object', 42, { title: 'fix(a): kept one' }],
      }) +
      '\n```';
    const out = parseSynthesisOutput(stdout);
    expect(out).toEqual([{ title: 'fix(a): kept one', priority: 3, items: [], description: '' }]);
  });
});
