// Purpose: cover the Skill Documenter agent — prompt building (via the prompt
// forwarded to spawnCli), NDJSON/markdown-fence/plain-text output parsing, and
// runSkillDocumenter's error handling (RateLimitError passthrough vs generic
// failure result). spawnCli/getAdapter are mocked; nothing here shells out.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkerResult } from './agentPair.js';

const spawnCli = vi.fn();

vi.mock('../adapters/index.js', () => ({
  getAdapter: () => ({}),
  spawnCli: (...args: unknown[]) => spawnCli(...(args as [])),
}));

const { runSkillDocumenter, formatSkillDocReport } = await import('./skillDocumenter.js');
const { RateLimitError } = await import('../adapters/rateLimitError.js');

const workerResult: WorkerResult = {
  success: true,
  summary: 'Added a new caching layer',
  filesChanged: ['src/cache.ts', 'src/index.ts'],
  commands: ['npm test'],
  output: 'done',
};

function baseOptions(overrides: Partial<Parameters<typeof runSkillDocumenter>[0]> = {}) {
  return {
    taskTitle: 'Add caching layer',
    taskDescription: 'Implement an LRU cache for the pipeline.',
    workerResult,
    projectPath: '/repo',
    ...overrides,
  };
}

describe('runSkillDocumenter prompt building', () => {
  beforeEach(() => spawnCli.mockClear());

  it('forwards a /documents prompt containing task + worker context to spawnCli', async () => {
    spawnCli.mockResolvedValueOnce({ stdout: '{"type":"result","result":"```json\\n{\\"success\\":true,\\"updatedFiles\\":[],\\"summary\\":\\"ok\\"}\\n```"}' });
    await runSkillDocumenter(baseOptions());
    expect(spawnCli).toHaveBeenCalledTimes(1);
    const opts = spawnCli.mock.calls[0][1] as { prompt: string; cwd: string };
    expect(opts.prompt).toContain('/documents');
    expect(opts.prompt).toContain('Add caching layer');
    expect(opts.prompt).toContain('Implement an LRU cache for the pipeline.');
    expect(opts.prompt).toContain('src/cache.ts, src/index.ts');
    expect(opts.prompt).toContain('npm test');
    expect(opts.cwd).toBe('/repo');
  });

  it('truncates a long task description with an ellipsis', async () => {
    spawnCli.mockResolvedValueOnce({ stdout: '{"type":"result","result":"{\\"success\\":true,\\"updatedFiles\\":[],\\"summary\\":\\"ok\\"}"}' });
    const longDesc = 'x'.repeat(250);
    await runSkillDocumenter(baseOptions({ taskDescription: longDesc }));
    const opts = spawnCli.mock.calls[0][1] as { prompt: string };
    expect(opts.prompt).toContain('x'.repeat(200) + '...');
    expect(opts.prompt).not.toContain('x'.repeat(201));
  });

  it('renders "(none)" for empty filesChanged/commands', async () => {
    spawnCli.mockResolvedValueOnce({ stdout: '{"type":"result","result":"{\\"success\\":true,\\"updatedFiles\\":[],\\"summary\\":\\"ok\\"}"}' });
    await runSkillDocumenter(baseOptions({ workerResult: { ...workerResult, filesChanged: [], commands: [] } }));
    const opts = spawnCli.mock.calls[0][1] as { prompt: string };
    expect(opts.prompt).toContain('**Files Changed:** (none)');
    expect(opts.prompt).toContain('**Commands:** (none)');
  });
});

describe('runSkillDocumenter output parsing', () => {
  beforeEach(() => spawnCli.mockClear());

  it('parses a fenced ```json block inside a NDJSON "result" event', async () => {
    const ndjson = JSON.stringify({
      type: 'result',
      result: '```json\n{"success":true,"updatedFiles":["CLAUDE.md","docs/architecture.md"],"summary":"Documented the cache"}\n```',
    });
    spawnCli.mockResolvedValueOnce({ stdout: ndjson });
    const result = await runSkillDocumenter(baseOptions());
    expect(result.success).toBe(true);
    expect(result.updatedFiles).toEqual(['CLAUDE.md', 'docs/architecture.md']);
    expect(result.summary).toBe('Documented the cache');
    expect(result.error).toBeUndefined();
  });

  it('parses an unfenced JSON object via brace-depth balancing', async () => {
    const ndjson = JSON.stringify({
      type: 'result',
      result: 'Some preamble text. {"success":false,"updatedFiles":[],"summary":"nothing to update","error":"docs dir missing"} trailing text',
    });
    spawnCli.mockResolvedValueOnce({ stdout: ndjson });
    const result = await runSkillDocumenter(baseOptions());
    expect(result.success).toBe(false);
    expect(result.updatedFiles).toEqual([]);
    expect(result.summary).toBe('nothing to update');
    expect(result.error).toBe('docs dir missing');
  });

  it('reads text from an item.completed agent_message event when there is no "result" event', async () => {
    const ndjson = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '```json\n{"success":true,"updatedFiles":["README.md"],"summary":"Updated README"}\n```' },
    });
    spawnCli.mockResolvedValueOnce({ stdout: ndjson });
    const result = await runSkillDocumenter(baseOptions());
    expect(result.success).toBe(true);
    expect(result.updatedFiles).toEqual(['README.md']);
    expect(result.summary).toBe('Updated README');
  });

  it('falls back to text extraction when the JSON block is malformed', async () => {
    const ndjson = JSON.stringify({
      type: 'result',
      result: '```json\n{ this is not valid json }\n```\nDocumentation successfully updated: docs/guide.md',
    });
    spawnCli.mockResolvedValueOnce({ stdout: ndjson });
    const result = await runSkillDocumenter(baseOptions());
    // extractFromText: hasSuccess ("updated") wins over hasError absence.
    expect(result.success).toBe(true);
    expect(result.updatedFiles).toContain('docs/guide.md');
  });

  it('falls back to plain-text extraction when stdout has no NDJSON at all', async () => {
    spawnCli.mockResolvedValueOnce({ stdout: 'Updated: docs/setup.md\nAll documentation is now current.' });
    const result = await runSkillDocumenter(baseOptions());
    expect(result.success).toBe(true);
    expect(result.updatedFiles).toContain('docs/setup.md');
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('flags failure and extracts an error message from plain text mentioning error/fail', async () => {
    spawnCli.mockResolvedValueOnce({ stdout: 'Error: could not write to docs/architecture.md\nAborting.' });
    const result = await runSkillDocumenter(baseOptions());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/could not write/i);
  });

  it('falls back to a raw matching line when no "keyword: message" colon pattern is present', async () => {
    spawnCli.mockResolvedValueOnce({ stdout: 'Something failed here\nbut we recovered' });
    const result = await runSkillDocumenter(baseOptions());
    expect(result.success).toBe(false);
    expect(result.error).toBe('Something failed here');
  });

  it('falls back to "Unknown error" when hasError is true but no line literally contains error/fail', async () => {
    // "Exception" trips the broader hasError test, but neither the colon-pattern
    // nor the plain error/fail line-scan matches, so extractErrorMessage bottoms out.
    spawnCli.mockResolvedValueOnce({ stdout: 'Exception occurred while parsing, but everything worked out' });
    const result = await runSkillDocumenter(baseOptions());
    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown error');
  });

  it('caps extracted updatedFiles at 10 entries', async () => {
    const lines = Array.from({ length: 15 }, (_, i) => `Updated: docs/file${i}.md`).join('\n');
    spawnCli.mockResolvedValueOnce({ stdout: `${lines}\nAll good, success.` });
    const result = await runSkillDocumenter(baseOptions());
    expect(result.updatedFiles.length).toBe(10);
  });

  it('falls back to extractFromText when a "result" event has no JSON at all (no fence, no brace)', async () => {
    const ndjson = JSON.stringify({ type: 'result', result: 'All done, no changes needed.' });
    spawnCli.mockResolvedValueOnce({ stdout: ndjson });
    const result = await runSkillDocumenter(baseOptions());
    expect(result.success).toBe(true);
    expect(result.summary).toBe('All done, no changes needed.');
  });

  it('returns null from the unfenced brace-balanced parse when the sliced text is still invalid JSON', async () => {
    // Python-style `True` (capitalized) inside otherwise brace-balanced text is not valid JSON,
    // so JSON.parse still throws after the depth-balancing slice — exercises the inner catch.
    const ndjson = JSON.stringify({
      type: 'result',
      result: 'noise before {"success": True} noise after, but successfully done',
    });
    spawnCli.mockResolvedValueOnce({ stdout: ndjson });
    const result = await runSkillDocumenter(baseOptions());
    // Falls through to extractFromText since extractResultJson returned null.
    expect(result.success).toBe(true);
    expect(result.summary).toContain('noise before');
  });

  it('returns "(no summary)" when every line of the fallback text is too short to summarize', async () => {
    spawnCli.mockResolvedValueOnce({ stdout: 'ok' });
    const result = await runSkillDocumenter(baseOptions());
    expect(result.summary).toBe('(no summary)');
  });

  it('extracts and logs cost info when the result event carries usage/cost fields', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ndjson = JSON.stringify({
      type: 'result',
      result: '{"success":true,"updatedFiles":[],"summary":"ok"}',
      total_cost_usd: 0.0321,
      usage: { input_tokens: 500, output_tokens: 200 },
      duration_ms: 4200,
    });
    spawnCli.mockResolvedValueOnce({ stdout: ndjson });
    const result = await runSkillDocumenter(baseOptions());
    expect(result.costInfo).toBeDefined();
    expect(result.costInfo!.costUsd).toBeCloseTo(0.0321);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[SkillDocumenter] Cost:'));
    logSpy.mockRestore();
  });
});

describe('runSkillDocumenter error handling', () => {
  beforeEach(() => spawnCli.mockClear());

  it('rethrows RateLimitError without wrapping it into a failure result', async () => {
    spawnCli.mockRejectedValueOnce(new RateLimitError(12345, 'quota exceeded'));
    await expect(runSkillDocumenter(baseOptions())).rejects.toBeInstanceOf(RateLimitError);
  });

  it('returns a failure result for a generic spawn error', async () => {
    spawnCli.mockRejectedValueOnce(new Error('boom: disk exploded'));
    const result = await runSkillDocumenter(baseOptions());
    expect(result.success).toBe(false);
    expect(result.updatedFiles).toEqual([]);
    expect(result.summary).toBe('Skill Documenter execution failed');
    expect(result.error).toBe('boom: disk exploded');
  });

  it('stringifies a non-Error throw', async () => {
    spawnCli.mockRejectedValueOnce('a plain string rejection');
    const result = await runSkillDocumenter(baseOptions());
    expect(result.success).toBe(false);
    expect(result.error).toBe('a plain string rejection');
  });

  it('recovers when the CLI resolves with a non-string stdout (defensive parse-error path)', async () => {
    // A malformed adapter result (stdout missing/non-string) makes `output.split`
    // throw inside parseSkillDocumenterOutput's NDJSON scan; this exercises its
    // outer catch (console.error + extractFromText fallback), which itself throws
    // again on a null input and is caught one level up by runSkillDocumenter.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    spawnCli.mockResolvedValueOnce({ stdout: null as unknown as string });
    const result = await runSkillDocumenter(baseOptions());
    expect(result.success).toBe(false);
    expect(result.summary).toBe('Skill Documenter execution failed');
    errorSpy.mockRestore();
  });
});

describe('formatSkillDocReport', () => {
  it('renders a success report with updated files', () => {
    const text = formatSkillDocReport({
      success: true,
      updatedFiles: ['CLAUDE.md', 'docs/architecture.md'],
      summary: 'Documented the new cache module',
    });
    expect(text).toContain('📄 **Skill Documenter Result: Complete**');
    expect(text).toContain('**Summary:** Documented the new cache module');
    expect(text).toContain('**Updated Files:** CLAUDE.md, docs/architecture.md');
    expect(text).not.toContain('**Error:**');
  });

  it('renders "(none)" when no files were updated', () => {
    const text = formatSkillDocReport({ success: true, updatedFiles: [], summary: 'Nothing to do' });
    expect(text).toContain('**Updated Files:** (none)');
  });

  it('renders a failure report with an error line', () => {
    const text = formatSkillDocReport({
      success: false,
      updatedFiles: [],
      summary: 'Documentation update failed',
      error: 'permission denied writing docs/',
    });
    expect(text).toContain('❌ **Skill Documenter Result: Failed**');
    expect(text).toContain('**Error:** permission denied writing docs/');
  });
});
