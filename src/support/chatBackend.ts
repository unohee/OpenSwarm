import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import type { AdapterName } from '../adapters/index.js';
import { getAdapter, getDefaultAdapterName } from '../adapters/index.js';
import { extractResultFromStreamJson } from '../agents/cliStreamParser.js';

export interface ChatCompletionOptions {
  prompt: string;
  provider?: AdapterName;
  model?: string;
  cwd?: string;
  sessionId?: string;
  timeoutMs?: number;
  onText?: (text: string, isThinking: boolean) => void;
  /** Tool-execution log from the agentic loop (`🔧 name: args`) for the chat UI. */
  onLog?: (line: string) => void;
  /** Max agentic turns (default 25); raised for autonomous /goal pursuit. */
  maxTurns?: number;
  /** Expose file/bash/web tools to the loop (default true). Set false for a plain classify/answer
   *  call like judgeGoalComplexity — the model just responds, no tool round-trips. */
  enableTools?: boolean;
  /** Abort the run (Esc/Ctrl+C). */
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  response: string;
  provider: AdapterName;
  model: string;
  sessionId?: string;
  cost?: number;
  tokens?: number;
}

export const CHAT_MODEL_ALIASES: Record<AdapterName, Record<string, string>> = {
  codex: {
    codex: 'gpt-5-codex',
    gpt5: 'gpt-5-codex',
    gpt5codex: 'gpt-5-codex',
  },
  'codex-responses': {
    // Codex backend tiers (see `openswarm auth models` for the live list).
    big: 'gpt-5.5',
    medium: 'gpt-5.4',
    small: 'gpt-5.4-mini',
    codex: 'gpt-5.3-codex',
  },
  gpt: {
    'gpt-4o': 'gpt-4o',
    'o3': 'o3',
    'o4-mini': 'o4-mini',
    'gpt-4.1': 'gpt-4.1',
  },
  local: {
    'gemma4': 'gemma3:4b',
    'gemma4-e4b': 'gemma3:4b',
    'gemma': 'gemma3:4b',
    'llama3': 'llama3.3:latest',
    'llama': 'llama3.3:latest',
    'mistral': 'mistral:latest',
    'codestral': 'codestral:latest',
    'qwen': 'qwen2.5-coder:7b',
    'qwen-coder': 'qwen2.5-coder:7b',
    'deepseek': 'deepseek-coder-v2:latest',
    'phi': 'phi4:latest',
    'starcoder': 'starcoder2:7b',
  },
  lmstudio: {
    local: process.env.LMSTUDIO_MODEL ?? 'local-model',
    lmstudio: process.env.LMSTUDIO_MODEL ?? 'local-model',
  },
  openrouter: {
    // Short aliases — full IDs (e.g. 'anthropic/claude-sonnet-4') pass through unchanged.
    sonnet: 'anthropic/claude-sonnet-4',
    opus: 'anthropic/claude-opus-4',
    haiku: 'anthropic/claude-haiku-4-5',
    'gpt-4o': 'openai/gpt-4o',
    'gpt-5': 'openai/gpt-5',
    'o4-mini': 'openai/o4-mini',
    gemini: 'google/gemini-2.5-pro',
    kimi: 'moonshotai/kimi-k2',
    glm: 'z-ai/glm-4.6',
  },
  // `claude -p` accepts short aliases (sonnet/opus/haiku) directly; full ids pass through.
  claude: {
    sonnet: 'sonnet',
    opus: 'opus',
    haiku: 'haiku',
  },
};

export function inferProviderFromModel(model?: string): AdapterName {
  if (!model) return getDefaultAdapterName();
  if (model.includes('codex')) return 'codex';
  // Bare claude ids/aliases → claude -p (anthropic/claude-… has a slash → openrouter, handled below).
  if (model.startsWith('claude-') || model === 'sonnet' || model === 'opus' || model === 'haiku') return 'claude';
  if (model.startsWith('gpt-') || model.startsWith('o3') || model.startsWith('o4')) return 'gpt';
  if (model.includes('/')) return 'openrouter';
  // 로컬 모델 패턴: ollama 태그 형식 (name:tag) 또는 알려진 오픈소스 모델
  if (model.includes(':') || /^(gemma|llama|mistral|codestral|qwen|deepseek|phi|starcoder)/i.test(model)) return 'local';
  return getDefaultAdapterName();
}

export function getDefaultChatModel(provider: AdapterName): string {
  // ChatGPT-account `codex exec` rejects 'gpt-5-codex' ("model is not supported when using Codex
  // with a ChatGPT account") → 400 → turn.failed → "[No response]" (INT-1658). gpt-5.5 passes model
  // validation; use it for chat like codex-responses does.
  if (provider === 'codex') return 'gpt-5.5';
  if (provider === 'codex-responses') return 'gpt-5.5';
  if (provider === 'gpt') return 'gpt-4o';
  if (provider === 'local') return 'gemma3:4b';
  if (provider === 'lmstudio') return process.env.LMSTUDIO_MODEL ?? 'local-model';
  if (provider === 'openrouter') return 'openai/gpt-5';
  if (provider === 'claude') return 'sonnet';
  return 'gpt-5-codex';
}

export function resolveChatModel(input: string | undefined, provider: AdapterName): string {
  if (!input) return getDefaultChatModel(provider);
  const alias = CHAT_MODEL_ALIASES[provider][input.toLowerCase()];
  return alias || input;
}

export interface GoalComplexity {
  tier: 'simple' | 'complex';
  /** subset of worker/reviewer/tester/documenter — which roles the goal warrants. */
  stages: string[];
}

/**
 * One quick no-tools classify call (INT-1603) so /goal sizes its approach to the work: a light
 * single pass for simple goals, an explicit worker→review (+test/docs) pass for complex ones.
 * Defaults to 'simple' on any error — never blocks the goal.
 */
export async function judgeGoalComplexity(
  goal: string,
  provider: AdapterName,
  model: string,
  signal?: AbortSignal,
): Promise<GoalComplexity> {
  const prompt =
    'Classify the complexity of this coding goal for an autonomous agent. Respond with ONLY a JSON object:\n' +
    '{"tier":"simple"|"complex","stages":[...]}\n' +
    '- "simple": a single focused change or question (one file, a small fix) → stages ["worker"].\n' +
    '- "complex": multi-file, needs design or verification → include "reviewer" (add "tester" if tests matter, "documenter" if docs do).\n\n' +
    `Goal: ${goal}`;
  try {
    const r = await runChatCompletion({
      prompt, provider, model, cwd: process.cwd(), timeoutMs: 60_000, enableTools: false, maxTurns: 1, signal,
    });
    const json = r.response.match(/\{[\s\S]*\}/)?.[0];
    if (json) {
      const j = JSON.parse(json) as { tier?: string; stages?: unknown };
      const tier: 'simple' | 'complex' = j.tier === 'complex' ? 'complex' : 'simple';
      const valid = new Set(['worker', 'reviewer', 'tester', 'documenter']);
      const stages = Array.isArray(j.stages)
        ? j.stages.filter((s): s is string => typeof s === 'string' && valid.has(s))
        : [];
      return { tier, stages: stages.length ? stages : (tier === 'complex' ? ['worker', 'reviewer'] : ['worker']) };
    }
  } catch {
    // fall through to the safe default
  }
  return { tier: 'simple', stages: ['worker'] };
}

/**
 * Run a complex /goal through the actual worker→reviewer(+tester/doc) PairPipeline (INT-1603),
 * built from the chat's own provider/model. Stage + log events are forwarded to the caller's UI.
 * Kept here (not in chatTui) so the TUI file stays under its size budget.
 */
export async function runGoalPipeline(opts: {
  goalText: string;
  description: string;
  stages: string[];
  provider: AdapterName;
  model: string;
  onStage: (stage: string) => void;
  onLog: (line: string) => void;
}): Promise<{ success: boolean; summary?: string }> {
  const { PairPipeline } = await import('../agents/pairPipeline.js');
  const stages = (opts.stages.length ? opts.stages : ['worker', 'reviewer']) as import('../core/types.js').PipelineStage[];
  const roles: Record<string, import('../core/types.js').RoleConfig> = {};
  for (const s of stages) {
    roles[s] = { enabled: true, model: opts.model, adapter: opts.provider, timeoutMs: 0 };
  }
  const task: import('../orchestration/decisionEngine.js').TaskItem = {
    id: `goal-${Date.now()}`, source: 'local', title: opts.goalText, description: opts.description,
    priority: 3, projectPath: process.cwd(), createdAt: Date.now(),
  };
  const pipeline = new PairPipeline({ stages, maxIterations: 3, roles });
  pipeline.on('stage:start', ({ stage }) => opts.onStage(stage));
  pipeline.on('log', ({ line }) => opts.onLog(line));
  const result = await pipeline.run(task, process.cwd());
  return { success: result.success, summary: result.workerResult?.summary };
}

export function shortenChatModel(model: string): string {
  // OpenRouter: "anthropic/claude-sonnet-4" → "claude-sonnet-4"
  if (model.includes('/')) return model.split('/').pop() ?? model;
  return model;
}

/**
 * API-based adapters (gpt/openrouter/local/codex-responses) execute via run(),
 * not a shell — their buildCommand is a stub, so spawning it returns nothing
 * ("No response"). Route chat through run() as a plain, tool-free single turn.
 */
async function runChatViaAdapter(
  adapter: ReturnType<typeof getAdapter>,
  provider: AdapterName,
  model: string,
  cwd: string,
  options: ChatCompletionOptions,
): Promise<ChatCompletionResult> {
  // run() adapters take the prompt as TEXT (it becomes the agentic-loop user
  // message) — unlike the codex CLI path, which treats options.prompt as a file
  // path to `cat`. Pass the message text directly.
  //
  // chat runs as a tool-using coding agent: file/bash/web tools enabled, multi-turn,
  // so it can actually read/edit/run in the working directory. Tokens stream via
  // onToken; tool executions surface through onLog.
  // Expose any MCP servers configured in ~/.openswarm/mcp.json as tools (cached).
  const { getMcpTools } = await import('../mcp/mcpClient.js');
  const mcpTools = await getMcpTools().catch(() => []);

  let streamed = false;
  const raw = await adapter.run!({
    prompt: options.prompt,
    cwd,
    model,
    systemPrompt:
      'You are a capable coding assistant operating in the user\'s current working directory, with tools to ' +
      'read/search/edit/create files, run shell commands, and call configured MCP server tools (named `server__tool`). ' +
      'Work like a thoughtful pair programmer who thinks out loud. Before each tool call, write one short sentence ' +
      'saying what you are about to do and why (e.g. "To find where X is defined, I\'ll search the source."). After a ' +
      'tool returns, briefly note what you found and your next step, then continue. Actually use the tools to perform ' +
      'the task — never just describe it. Keep narration to a sentence or two between actions, not essays. ' +
      'For a trivial question with no task, just answer directly without tools.',
    enableTools: options.enableTools ?? true,
    webTools: options.enableTools ?? true,
    mcpTools,
    // A high safety ceiling, not a task limit — normal work ends when the model
    // stops calling tools; the progress-based stop catches stuck loops earlier.
    maxTurns: options.maxTurns ?? 80,
    timeoutMs: options.timeoutMs ?? 300000,
    // Stream tokens live when the adapter supports it (codex-responses / chat
    // completions); the chat TUI renders each delta as it arrives.
    onToken: options.onText
      ? (delta) => {
          streamed = true;
          options.onText!(delta, false);
        }
      : undefined,
    // Tool executions (🔧 …) surface to the chat UI.
    onLog: options.onLog,
    signal: options.signal,
  });
  if (raw.exitCode !== 0 && !raw.stdout.trim()) {
    throw new Error(raw.stderr.trim() || `${provider} exited with code ${raw.exitCode}`);
  }
  const text = raw.stdout.trim();
  // Non-streaming adapters emit nothing via onToken — flush the full reply once.
  if (!streamed) options.onText?.(text, false);
  return { response: text || '[No response]', provider, model };
}

export async function runChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const provider = options.provider ?? inferProviderFromModel(options.model);
  const model = resolveChatModel(options.model, provider);
  const adapter = getAdapter(provider);
  const cwd = options.cwd ?? process.cwd();

  if (typeof adapter.run === 'function') {
    return runChatViaAdapter(adapter, provider, model, cwd, options);
  }

  const promptFile = `/tmp/openswarm-chat-${Date.now()}.txt`;
  await writeFile(promptFile, options.prompt);

  try {
    const { command, args } = adapter.buildCommand({
      prompt: promptFile,
      cwd,
      model,
    });
    const cmd = [command, ...args].join(' ');

    return await new Promise<ChatCompletionResult>((resolve, reject) => {
      const proc = spawn(cmd, {
        shell: true,
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let buffer = '';
      let capturedSessionId = options.sessionId || '';
      let startedStreaming = false;
      let thinkingTimer: NodeJS.Timeout | null = null;
      let timeout: NodeJS.Timeout | null = null;

      const resetThinkingTimer = () => {
        if (!options.onText) return;
        if (thinkingTimer) clearTimeout(thinkingTimer);
        thinkingTimer = setTimeout(() => {
          if (startedStreaming) options.onText?.('', true);
        }, 2000);
      };

      const flushLines = (force = false) => {
        const lines = buffer.split('\n');
        buffer = force ? '' : (lines.pop() ?? '');
        for (const raw of force ? lines.concat(buffer ? [buffer] : []) : lines) {
          const line = raw.trim();
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
              startedStreaming = true;
              options.onText?.(event.item.text, false);
              resetThinkingTimer();
            }
            if (event.type === 'item.completed' && event.item?.type === 'reasoning') {
              options.onText?.('', true);
            }
          } catch {
            // Ignore malformed lines.
          }
        }
      };

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        buffer += text;
        flushLines(false);
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      if ((options.timeoutMs ?? 180000) > 0) {
        timeout = setTimeout(() => {
          proc.kill('SIGKILL');
          reject(new Error('Chat response timeout'));
        }, options.timeoutMs ?? 180000);
      }

      proc.on('close', (code) => {
        if (timeout) clearTimeout(timeout);
        if (thinkingTimer) clearTimeout(thinkingTimer);
        flushLines(true);

        if (code !== 0 && !stdout.trim()) {
          reject(new Error(stderr.trim() || `${provider} exited with code ${code}`));
          return;
        }

        // codex emits the answer in `item.completed agent_message`; claude -p (stream-json) wraps it
        // in a `result` event. Try codex form first, then fall back to the generic stream-json result.
        const answer = extractCodexChatResponse(stdout) || (extractResultFromStreamJson(stdout) ?? '');
        // No answer? The turn may have FAILED with an error event (e.g. usage limit) that exits 0,
        // so it never hit the reject above. Surface that reason instead of a blank "[No response]".
        const response = answer || extractStreamErrorMessage(stdout) || '[No response]';

        resolve({
          response,
          provider,
          model,
          sessionId: capturedSessionId || undefined,
          cost: undefined,
          tokens: undefined,
        });
      });

      proc.on('error', (error) => {
        if (timeout) clearTimeout(timeout);
        if (thinkingTimer) clearTimeout(thinkingTimer);
        reject(error);
      });
    });
  } finally {
    try {
      await unlink(promptFile);
    } catch {
      // Ignore temp cleanup errors.
    }
  }
}

function extractCodexChatResponse(stdout: string): string {
  let lastMessage = '';
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        lastMessage = event.item.text.trim();
      }
    } catch {
      // Ignore malformed lines.
    }
  }
  return lastMessage;
}

/**
 * Pull a human-readable failure reason out of a CLI stream when the turn produced no answer.
 * codex emits `{"type":"error","message":"…"}` (the message is often itself a JSON string), and a
 * stream may carry a `result` event flagged `is_error`. Without this, a usage-limit / rate-limit
 * failure (which exits 0) was masked as a blank "[No response]". Returns '' when no error is found.
 */
function extractStreamErrorMessage(stdout: string): string {
  let raw = '';
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event.type === 'error' && typeof event.message === 'string') raw = event.message;
      else if (event.type === 'result' && event.is_error && typeof event.result === 'string') raw = event.result || raw;
    } catch {
      // Ignore malformed lines.
    }
  }
  if (!raw) return '';
  // codex nests the real error as a JSON string inside `message` — unwrap it.
  try {
    const inner = JSON.parse(raw) as { error?: { message?: string }; message?: string };
    raw = inner.error?.message ?? inner.message ?? raw;
  } catch {
    // raw is already a plain string.
  }
  if (/usage limit|rate limit|quota|too many requests|\b429\b|insufficient.*credit/i.test(raw)) {
    return `⚠️ Usage limit reached — ${raw}`;
  }
  return `⚠️ Provider error — ${raw}`;
}

