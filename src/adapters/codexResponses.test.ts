import { describe, it, expect } from 'vitest';
import { chatToResponsesInput, toolsToResponsesTools, reduceResponsesEvents, resolveReasoningEffort } from './codexResponses.js';
import type { ChatMessage } from './agenticLoop.js';
import type { ToolDefinition } from './tools.js';

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
      { type: 'function', name: 'bash', description: 'run', parameters: { type: 'object' } },
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
    expect(res.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
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
