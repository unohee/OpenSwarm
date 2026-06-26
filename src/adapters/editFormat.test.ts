// ============================================
// OpenSwarm - Edit-format matching tests (INT-1676)
// Covers the capability resolver + the agentic loop's SEARCH/REPLACE path:
// edit_file/apply_patch hidden for weak models, S/R blocks parsed & applied.
// ============================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgenticLoop, type ChatMessage } from './agenticLoop.js';
import type { ToolDefinition } from './tools.js';
import { resolveEditFormat } from '../support/editParser.js';

const finalResp = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

describe('resolveEditFormat (INT-1676)', () => {
  afterEach(() => { delete process.env.OPENSWARM_EDIT_FORMAT; });

  it('routes weak in-process adapters to search-replace', () => {
    expect(resolveEditFormat('local')).toBe('search-replace');
    expect(resolveEditFormat('lmstudio')).toBe('search-replace');
    expect(resolveEditFormat('openrouter')).toBe('search-replace');
  });

  it('keeps capable adapters on json', () => {
    expect(resolveEditFormat('claude')).toBe('json');
    expect(resolveEditFormat('codex')).toBe('json');
    expect(resolveEditFormat('codex-responses')).toBe('json');
    expect(resolveEditFormat('gpt')).toBe('json');
    expect(resolveEditFormat(undefined)).toBe('json');
  });

  it('OPENSWARM_EDIT_FORMAT overrides per-adapter routing (rollback lever)', () => {
    process.env.OPENSWARM_EDIT_FORMAT = 'json';
    expect(resolveEditFormat('local')).toBe('json');
    process.env.OPENSWARM_EDIT_FORMAT = 'search-replace';
    expect(resolveEditFormat('claude')).toBe('search-replace');
  });

  it('ignores a bogus env value and falls back to per-adapter routing', () => {
    process.env.OPENSWARM_EDIT_FORMAT = 'nonsense';
    expect(resolveEditFormat('local')).toBe('search-replace');
    expect(resolveEditFormat('claude')).toBe('json');
  });
});

describe('agenticLoop edit-format wiring (INT-1676)', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'editfmt-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  const toolNames = (tools: ToolDefinition[]) => tools.map(t => t.function.name);

  it('hides edit_file in search-replace mode and keeps it in json mode', async () => {
    let seen: string[] = [];
    const callApi = async (_m: ChatMessage[], tools: ToolDefinition[]) => {
      seen = toolNames(tools);
      return finalResp('done');
    };

    await runAgenticLoop({ prompt: 'x', cwd: tmp, model: 't', callApi, webTools: false, maxTurns: 2, editFormat: 'json' });
    expect(seen).toContain('edit_file');

    await runAgenticLoop({ prompt: 'x', cwd: tmp, model: 't', callApi, webTools: false, maxTurns: 2, editFormat: 'search-replace' });
    expect(seen).not.toContain('edit_file');
  });

  it('parses a SEARCH/REPLACE block from the response and applies it to disk', async () => {
    await fs.writeFile(path.join(tmp, 'a.ts'), 'const v = 1;\n', 'utf-8');

    const srBlock =
      'Here is the fix:\n\n' +
      'a.ts\n' +
      '```typescript\n' +
      '<<<<<<< SEARCH\n' +
      'const v = 1;\n' +
      '=======\n' +
      'const v = 2;\n' +
      '>>>>>>> REPLACE\n' +
      '```\n';

    let call = 0;
    const callApi = async () => {
      call++;
      // 1st turn: emit the S/R block; 2nd turn: finish (no block).
      return call === 1 ? finalResp(srBlock) : finalResp('all done');
    };

    const res = await runAgenticLoop({
      prompt: 'change v to 2', cwd: tmp, model: 't', callApi,
      webTools: false, maxTurns: 5, editFormat: 'search-replace',
    });

    expect(res.text).toBe('all done');
    expect(await fs.readFile(path.join(tmp, 'a.ts'), 'utf-8')).toBe('const v = 2;\n');
    expect(call).toBe(2); // looped once after applying, then finished
  });

  it('rejects a SEARCH/REPLACE block whose path escapes the project root', async () => {
    const srBlock =
      '../../escape.ts\n```ts\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n```\n';
    let call = 0;
    const callApi = async () => { call++; return call === 1 ? finalResp(srBlock) : finalResp('stopped'); };

    await runAgenticLoop({
      prompt: 'escape', cwd: tmp, model: 't', callApi,
      webTools: false, maxTurns: 5, editFormat: 'search-replace',
    });

    // No file created outside the sandbox root.
    await expect(fs.access(path.join(tmp, '..', '..', 'escape.ts'))).rejects.toThrow();
  });

  it('stops after consecutive turns where every SEARCH/REPLACE block fails (stall guard)', async () => {
    await fs.writeFile(path.join(tmp, 'a.ts'), 'real content\n', 'utf-8');
    // SEARCH text never matches → every turn fails to apply.
    const badBlock =
      'a.ts\n```ts\n<<<<<<< SEARCH\nDOES NOT EXIST\n=======\nnope\n>>>>>>> REPLACE\n```\n';
    let call = 0;
    const callApi = async () => { call++; return finalResp(badBlock); };

    const res = await runAgenticLoop({
      prompt: 'loop', cwd: tmp, model: 't', callApi,
      webTools: false, maxTurns: 20, editFormat: 'search-replace',
    });

    // Bailed at the stall limit (2), not after maxTurns (20).
    expect(call).toBeLessThanOrEqual(3);
    expect(res.text).toContain('DOES NOT EXIST');
    expect(await fs.readFile(path.join(tmp, 'a.ts'), 'utf-8')).toBe('real content\n');
  });

  it('whole-file mode hides edit_file/apply_patch but keeps write_file', async () => {
    let seen: string[] = [];
    const callApi = async (_m: ChatMessage[], tools: ToolDefinition[]) => {
      seen = toolNames(tools);
      return finalResp('done');
    };
    await runAgenticLoop({
      prompt: 'x', cwd: tmp, model: 't', callApi,
      webTools: false, maxTurns: 2, editFormat: 'whole-file', applyPatch: true,
    });
    expect(seen).not.toContain('edit_file');
    expect(seen).not.toContain('apply_patch');
    expect(seen).toContain('write_file');
  });

  it('refuses to apply a SEARCH/REPLACE block targeting a protected file', async () => {
    const guard = path.join(tmp, 'guard.test.ts');
    await fs.writeFile(guard, 'keep me', 'utf-8');

    const srBlock =
      'guard.test.ts\n```ts\n<<<<<<< SEARCH\nkeep me\n=======\nhacked\n>>>>>>> REPLACE\n```\n';

    let call = 0;
    const callApi = async () => { call++; return call === 1 ? finalResp(srBlock) : finalResp('stopped'); };

    await runAgenticLoop({
      prompt: 'edit guard', cwd: tmp, model: 't', callApi,
      webTools: false, maxTurns: 5, editFormat: 'search-replace',
      protectedFiles: [guard],
    });

    // Untouched — protected-file guard rejected the block before applying.
    expect(await fs.readFile(guard, 'utf-8')).toBe('keep me');
  });
});
