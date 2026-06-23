// ============================================
// OpenSwarm - Codex Responses-API Adapter
// Calls chatgpt.com/backend-api/codex/responses via ChatGPT OAuth — no codex CLI.
// Runs on OpenSwarm's OWN agentic loop so tools/verification stay under our control
// (unlike the codex `exec` CLI, which is a black box). INT-1586.
// ============================================

import type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  WorkerResult,
  ReviewResult,
} from './types.js';
import { AuthProfileStore, ensureValidToken } from '../auth/index.js';
import { runAgenticLoop, loopResultToCliResult, type ChatMessage, type AgenticLoopOptions } from './agenticLoop.js';
import { parseWorkerResult, parseReviewerResult } from './resultParsing.js';
import type { ToolDefinition } from './tools.js';

import { getCodexModelIds } from './codexModels.js';

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const DEFAULT_MODEL = 'gpt-5.5';
const PROFILE_KEY = 'openai-gpt:default';

// ---- Responses API wire types (the subset we send/receive) ----

interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

type ResponsesInputItem =
  | { role: 'user' | 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

/** The agenticLoop callApi return shape (structurally equals its ChatCompletionResponse). */
interface ChatLikeResponse {
  choices: Array<{
    message: { role: string; content: string | null; tool_calls?: ApiToolCallShape[] };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface ApiToolCallShape {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// ---- Transforms (exported for unit tests) ----

/** ChatMessage[] → Responses `{ instructions, input[] }`. system → instructions. */
export function chatToResponsesInput(messages: ChatMessage[]): {
  instructions: string;
  input: ResponsesInputItem[];
} {
  const systemParts: string[] = [];
  const input: ResponsesInputItem[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content);
    } else if (m.role === 'user') {
      input.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: m.content });
      for (const tc of m.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content });
    }
  }

  return { instructions: systemParts.join('\n\n'), input };
}

/** OpenSwarm ToolDefinition (nested `function:{}`) → Responses flat tool. */
export function toolsToResponsesTools(tools: ToolDefinition[]): ResponsesTool[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}

interface SseEvent {
  type?: string;
  delta?: string;
  item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
  item_id?: string;
  arguments?: string;
  response?: {
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
  };
}

/**
 * Reduce parsed Responses SSE events → a chat-completions-shaped response.
 * Exported so the SSE→chat mapping is unit-testable without a live stream.
 */
export function reduceResponsesEvents(events: SseEvent[]): ChatLikeResponse {
  let text = '';
  // Keyed by the streaming item id; the emitted tool-call id is the call_id so it
  // round-trips back as `function_call_output.call_id` on the next turn.
  const calls = new Map<string, { callId: string; name: string; args: string }>();
  let usage: ChatLikeResponse['usage'];

  for (const ev of events) {
    switch (ev.type) {
      case 'response.output_text.delta':
        if (ev.delta) text += ev.delta;
        break;
      case 'response.output_item.added':
        if (ev.item?.type === 'function_call' && ev.item.id) {
          calls.set(ev.item.id, {
            callId: ev.item.call_id || ev.item.id,
            name: ev.item.name ?? '',
            args: ev.item.arguments ?? '',
          });
        }
        break;
      case 'response.function_call_arguments.delta': {
        const c = ev.item_id ? calls.get(ev.item_id) : undefined;
        if (c && ev.delta) c.args += ev.delta;
        break;
      }
      case 'response.function_call_arguments.done': {
        const c = ev.item_id ? calls.get(ev.item_id) : undefined;
        if (c && typeof ev.arguments === 'string') c.args = ev.arguments;
        break;
      }
      case 'response.completed': {
        const u = ev.response?.usage;
        if (u) {
          const pt = u.input_tokens ?? 0;
          const ct = u.output_tokens ?? 0;
          usage = { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct };
        }
        break;
      }
    }
  }

  const toolCalls: ApiToolCallShape[] = [...calls.values()].map((c) => ({
    id: c.callId,
    type: 'function',
    function: { name: c.name, arguments: c.args },
  }));

  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: text || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage,
  };
}

/** Parse a `data: {json}` SSE line into an event, or null for keep-alives/[DONE]. */
function parseSseLine(line: string): SseEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data) as SseEvent;
  } catch {
    return null;
  }
}

/**
 * Read the whole SSE body and reduce it to a chat-shaped response. When
 * `onToken` is provided, each `response.output_text.delta` is emitted live so
 * the chat TUI can stream tokens as they arrive.
 */
async function consumeResponsesStream(res: Response, onToken?: (delta: string) => void): Promise<ChatLikeResponse> {
  const events: SseEvent[] = [];
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Codex responses: empty stream body');

  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (ev: SseEvent | null) => {
    if (!ev) return;
    events.push(ev);
    if (onToken && ev.type === 'response.output_text.delta' && ev.delta) onToken(ev.delta);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) handle(parseSseLine(line));
  }
  handle(parseSseLine(buffer));

  return reduceResponsesEvents(events);
}

// ---- Adapter ----

export class CodexResponsesAdapter implements CliAdapter {
  readonly name = 'codex-responses';

  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: false, // the loop sees a single aggregated response per call
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: [],
  };

  async isAvailable(): Promise<boolean> {
    try {
      const store = new AuthProfileStore();
      const profile = store.getProfile(PROFILE_KEY);
      // Needs a ChatGPT OAuth profile carrying the codex account_id.
      return profile !== null && Boolean(profile.accountId);
    } catch {
      return false;
    }
  }

  buildCommand(_options: CliRunOptions): { command: string; args: string[] } {
    return { command: 'echo', args: ['"codex-responses adapter uses run() — not shell spawn"'] };
  }

  /** Default = top model from the Codex OAuth catalog (live/local), else constant. */
  async getDefaultModel(): Promise<string> {
    const [first] = await getCodexModelIds();
    return first ?? DEFAULT_MODEL;
  }

  async run(options: CliRunOptions): Promise<CliRunResult> {
    const store = new AuthProfileStore();
    const startTime = Date.now();

    let accessToken: string;
    let accountId: string;
    try {
      accessToken = await ensureValidToken(store, PROFILE_KEY);
      accountId = store.getProfile(PROFILE_KEY)?.accountId ?? '';
      if (!accountId) {
        throw new Error(
          'No chatgpt-account-id on the OAuth profile. Re-run: openswarm auth login --provider gpt',
        );
      }
    } catch (err) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Auth error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
      };
    }

    const model = options.model ?? await this.getDefaultModel();
    const callApi = this.createApiCaller(accessToken, accountId, store, model, options.onToken, options.signal);

    const loopOptions: AgenticLoopOptions = {
      systemPrompt: options.systemPrompt,
      prompt: options.prompt,
      cwd: options.cwd ?? process.cwd(),
      model,
      callApi,
      maxTurns: options.maxTurns ?? 15,
      timeoutMs: options.timeoutMs || 300000,
      onLog: options.onLog,
      enableTools: options.enableTools ?? true,
      nudgeMaxOnNoEdit: options.nudgeMaxOnNoEdit,
      protectedFiles: options.protectedFiles,
      bashTimeoutMs: options.bashTimeoutMs,
      webTools: options.webTools,
      mcpTools: options.mcpTools,
      signal: options.signal,
    };

    try {
      const result = await runAgenticLoop(loopOptions);
      if (options.onLog) {
        options.onLog(`[Codex ${model}] ${result.apiCallCount} API calls, ${result.toolCallCount} tool uses, ${result.totalTokens} tokens`);
      }
      return loopResultToCliResult(result);
    } catch (err) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Codex responses loop failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /** Build the agentic-loop callApi: POST /responses + chat↔Responses conversion. */
  private createApiCaller(
    initialToken: string,
    accountId: string,
    store: AuthProfileStore,
    model: string,
    onToken?: (delta: string) => void,
    signal?: AbortSignal,
  ) {
    let token = initialToken;
    let retried = false;

    return async (messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatLikeResponse> => {
      const { instructions, input } = chatToResponsesInput(messages);
      const body: Record<string, unknown> = {
        model,
        input,
        store: false,
        stream: true,
      };
      if (instructions) body.instructions = instructions;
      if (tools.length > 0) body.tools = toolsToResponsesTools(tools);
      // NOTE: never set max_output_tokens — the Codex backend rejects it with HTTP 400.

      const doCall = async (accessToken: string): Promise<ChatLikeResponse> => {
        const res = await fetch(CODEX_RESPONSES_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': `Bearer ${accessToken}`,
            'chatgpt-account-id': accountId,
            'originator': 'openswarm',
            'OpenAI-Beta': 'responses=experimental',
          },
          body: JSON.stringify(body),
          signal,
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          // 401 → refresh once and retry.
          if (res.status === 401 && !retried) {
            retried = true;
            token = await refreshAndRetry(store);
            return doCall(token);
          }
          throw new Error(`Codex responses error (${res.status}): ${errText.slice(0, 500)}`);
        }

        return consumeResponsesStream(res, onToken);
      };

      return doCall(token);
    };
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    return parseWorkerResult(raw.stdout);
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    return parseReviewerResult(raw.stdout);
  }
}

async function refreshAndRetry(store: AuthProfileStore): Promise<string> {
  const profile = store.getProfile(PROFILE_KEY);
  if (!profile) throw new Error('No auth profile found');
  profile.expires = 0; // force refresh
  store.setProfile(PROFILE_KEY, profile);
  return ensureValidToken(store, PROFILE_KEY);
}
