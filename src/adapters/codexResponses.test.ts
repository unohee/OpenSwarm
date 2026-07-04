import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexResponsesAdapter,
  chatToResponsesInput,
  toolsToResponsesTools,
  reduceResponsesEvents,
  resolveReasoningEffort,
  selectDefaultCodexResponseModel,
} from './codexResponses.js';
import { runAgenticLoop, type ChatMessage } from './agenticLoop.js';
import type { ToolDefinition } from './tools.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('selectDefaultCodexResponseModel', () => {
  it('prefers the stable default when the live catalog includes it', () => {
    expect(selectDefaultCodexResponseModel(['gpt-5.3-codex-spark', 'gpt-5.4-mini', 'gpt-5.5'])).toBe('gpt-5.5');
  });

  it('does not pick Spark implicitly when another model is available', () => {
    expect(selectDefaultCodexResponseModel(['gpt-5.3-codex-spark', 'gpt-5.4-mini'])).toBe('gpt-5.4-mini');
  });

  it('does not choose Spark implicitly even if it is the only discovered model', () => {
    expect(selectDefaultCodexResponseModel(['gpt-5.3-codex-spark'])).toBe('gpt-5.5');
  });
});

describe('unsupported-model fallback', () => {
  it('persists the fallback model across subsequent tool-loop API turns', async () => {
    const requestedModels: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/backend-api/codex/models')) {
        return new Response(JSON.stringify({ models: [{ slug: 'gpt-5.5', priority: 1 }] }), { status: 200 });
      }

      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      requestedModels.push(String(body.model));
      if (body.model === 'unsupported-model') {
        return new Response('model is not supported for this account', { status: 400 });
      }

      return new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"ok"}',
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
          'data: [DONE]',
          '',
        ].join('\n'),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    type CreateApiCaller = (
      initialToken: string,
      accountId: string,
      store: unknown,
      model: string,
    ) => (messages: ChatMessage[], tools: ToolDefinition[]) => Promise<unknown>;
    const adapter = new CodexResponsesAdapter() as unknown as { createApiCaller: CreateApiCaller };
    const callApi = adapter.createApiCaller('token', 'account', {}, 'unsupported-model');

    await callApi([{ role: 'user', content: 'first' }], []);
    await callApi([{ role: 'user', content: 'second' }], []);

    expect(requestedModels).toEqual(['unsupported-model', 'gpt-5.5', 'gpt-5.5']);
  });
});

describe('chatToResponsesInput', () => {
  it('lifts system messages into instructions and keeps user/assistant as input', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are precise.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const { instructions, input } = chatToResponsesInput(messages);
    expect(instructions).toBe('You are precise.');
    expect(input).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('maps assistant tool_calls → function_call and tool results → function_call_output', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'read file' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
    ];
    const { input } = chatToResponsesInput(messages);
    expect(input).toEqual([
      { role: 'user', content: 'read file' },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file body' },
    ]);
  });

  it('concatenates multiple system messages', () => {
    const { instructions } = chatToResponsesInput([
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
    ]);
    expect(instructions).toBe('A\n\nB');
  });
});

describe('toolsToResponsesTools', () => {
  it('flattens the nested function:{} into the Responses flat tool shape', () => {
    const tools: ToolDefinition[] = [
      { type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object' } } },
    ];
    expect(toolsToResponsesTools(tools)).toEqual([
      { type: 'function', name: 'bash', description: 'run', parameters: { type: 'object' }, strict: false },
    ]);
  });
});

describe('reduceResponsesEvents', () => {
  it('accumulates output_text deltas into assistant content with finish_reason stop', () => {
    const res = reduceResponsesEvents([
      { type: 'response.output_text.delta', delta: 'Hel' },
      { type: 'response.output_text.delta', delta: 'lo' },
      { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 } } },
    ]);
    expect(res.choices[0].message.content).toBe('Hello');
    expect(res.choices[0].message.tool_calls).toBeUndefined();
    expect(res.choices[0].finish_reason).toBe('stop');
    expect(res.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cached_tokens: 0 });
  });

  it('surfaces cached_tokens from input_tokens_details (prompt-cache observability)', () => {
    const res = reduceResponsesEvents([
      { type: 'response.output_text.delta', delta: 'ok' },
      { type: 'response.completed', response: { usage: { input_tokens: 1000, output_tokens: 10, input_tokens_details: { cached_tokens: 800 } } } },
    ]);
    expect(res.usage).toEqual({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, cached_tokens: 800 });
  });

  it('assembles a function_call from added + arguments.delta, keyed by item id, emitting call_id', () => {
    const res = reduceResponsesEvents([
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'edit_file' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"x.ts"}' },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 4 } } },
    ]);
    const tc = res.choices[0].message.tool_calls;
    expect(tc).toHaveLength(1);
    expect(tc![0]).toEqual({ id: 'call_9', type: 'function', function: { name: 'edit_file', arguments: '{"path":"x.ts"}' } });
    expect(res.choices[0].finish_reason).toBe('tool_calls');
  });

  it('arguments.done overrides accumulated deltas', () => {
    const res = reduceResponsesEvents([
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'bash' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: 'partial' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"cmd":"ls"}' },
    ]);
    expect(res.choices[0].message.tool_calls![0].function.arguments).toBe('{"cmd":"ls"}');
  });

  it('accepts final function-call details from response.output_item.done', () => {
    const res = reduceResponsesEvents([
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'emit_marker', arguments: '' } },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'emit_marker', arguments: '{"marker":"SPARK_TOOL_OK"}' } },
    ]);
    expect(res.choices[0].message.tool_calls![0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'emit_marker', arguments: '{"marker":"SPARK_TOOL_OK"}' },
    });
  });

  it('maps Spark-style argument done events even when item_id is omitted for a single call', () => {
    const res = reduceResponsesEvents([
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'emit_marker' } },
      { type: 'response.function_call_arguments.done', arguments: '{"marker":"SPARK_TOOL_OK"}' },
    ]);
    expect(res.choices[0].message.tool_calls![0].function.arguments).toBe('{"marker":"SPARK_TOOL_OK"}');
  });

  it('reduces the live-observed Spark function-call event sequence', () => {
    const res = reduceResponsesEvents([
      { type: 'response.created' },
      { type: 'response.in_progress' },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'emit_marker', arguments: '' } },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'emit_marker', arguments: '{"marker":"SPARK_TOOL_OK"}' } },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"marker":"SPARK_TOOL_OK"}' },
      { type: 'response.completed', response: { usage: { input_tokens: 42, output_tokens: 7 } } },
    ]);

    expect(res.choices[0]).toEqual({
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'emit_marker', arguments: '{"marker":"SPARK_TOOL_OK"}' },
          },
        ],
      },
    });
    expect(res.usage).toEqual({ prompt_tokens: 42, completion_tokens: 7, total_tokens: 49, cached_tokens: 0 });
  });
});

describe('Spark-shaped Responses events through the OpenSwarm loop', () => {
  it('executes an apply_patch tool call and feeds the result into the next turn', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'openswarm-spark-loop-'));
    const filePath = join(cwd, 'note.txt');
    writeFileSync(filePath, 'status=ALPHA', 'utf8');
    const patch = [
      '*** Begin Patch',
      '*** Update File: note.txt',
      '@@',
      '-status=ALPHA',
      '+status=SPARK_TOOL_OK',
      '*** End Patch',
    ].join('\n');
    let apiCalls = 0;

    try {
      const result = await runAgenticLoop({
        cwd,
        model: 'gpt-5.3-codex-spark',
        prompt: 'Change note.txt to SPARK_TOOL_OK.',
        webTools: false,
        applyPatch: true,
        maxTurns: 4,
        callApi: async (messages, tools) => {
          apiCalls++;
          if (apiCalls === 1) {
            expect(tools.some((t) => t.function.name === 'apply_patch')).toBe(true);
            return reduceResponsesEvents([
              { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_patch', call_id: 'call_patch', name: 'apply_patch', arguments: '' } },
              {
                type: 'response.output_item.done',
                item: {
                  type: 'function_call',
                  id: 'fc_patch',
                  call_id: 'call_patch',
                  name: 'apply_patch',
                  arguments: JSON.stringify({ input: patch }),
                },
              },
              { type: 'response.function_call_arguments.done', item_id: 'fc_patch', arguments: JSON.stringify({ input: patch }) },
            ]);
          }

          expect(messages.some((m) => m.role === 'tool' && m.content.includes('Patched: note.txt'))).toBe(true);
          return {
            choices: [{ message: { role: 'assistant', content: 'status=SPARK_TOOL_OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      });

      expect(result.toolCallCount).toBe(1);
      expect(result.text).toBe('status=SPARK_TOOL_OK');
      expect(readFileSync(filePath, 'utf8')).toBe('status=SPARK_TOOL_OK');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('resolveReasoningEffort — jobProfile effort wiring', () => {
  it('explicit profile effort wins over disableReasoning', () => {
    expect(resolveReasoningEffort('high', true)).toBe('high');
    expect(resolveReasoningEffort('high', false)).toBe('high');
    expect(resolveReasoningEffort('low', false)).toBe('low');
  });

  it('falls back to low when reasoning is disabled (worker default)', () => {
    expect(resolveReasoningEffort(undefined, true)).toBe('low');
  });

  it('falls back to medium otherwise', () => {
    expect(resolveReasoningEffort(undefined, false)).toBe('medium');
    expect(resolveReasoningEffort(undefined, undefined)).toBe('medium');
  });
})

const liveSparkIt = process.env.OPEN_SWARM_LIVE_CODEX_SPARK ? it : it.skip;

describe('codex-responses live Spark smoke', () => {
  // Opt-in because this hits the ChatGPT OAuth backend. Manual evidence captured
  // while adding explicit Spark support: this test passed with Spark calling
  // read_file → apply_patch → read_file and changing note.txt to SPARK_TOOL_OK.
  liveSparkIt('uses PKCE auth and Spark to edit through the OpenSwarm tool loop', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'openswarm-spark-edit-'));
    const filePath = join(cwd, 'note.txt');
    writeFileSync(filePath, 'status=ALPHA\n', 'utf8');
    const logs: string[] = [];

    try {
      const result = await new CodexResponsesAdapter().run({
        cwd,
        model: 'gpt-5.3-codex-spark',
        prompt:
          'Use tools to edit note.txt. Change the exact text "status=ALPHA" to "status=SPARK_TOOL_OK". ' +
          'After editing, verify by reading the file and answer with the final file content only.',
        systemPrompt:
          'You are an edit-tool smoke test. You must inspect and modify the file using tools; do not answer without editing.',
        enableTools: true,
        webTools: false,
        maxTurns: 8,
        nudgeMaxOnNoEdit: 2,
        timeoutMs: 180000,
        onLog: (line) => logs.push(line),
      });

      expect(result.exitCode).toBe(0);
      expect(logs.some((line) => /edit_file|apply_patch|write_file/.test(line))).toBe(true);
      expect(readFileSync(filePath, 'utf8').trim()).toBe('status=SPARK_TOOL_OK');
      expect(result.stdout).toContain('SPARK_TOOL_OK');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180000);
});
