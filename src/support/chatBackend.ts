import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import type { AdapterName } from '../adapters/index.js';
import { getAdapter, getDefaultAdapterName } from '../adapters/index.js';

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
  claude: {
    // `claude -p --model <alias>` takes version-robust aliases directly.
    sonnet: 'sonnet',
    opus: 'opus',
    haiku: 'haiku',
  },
};

export function inferProviderFromModel(model?: string): AdapterName {
  if (!model) return getDefaultAdapterName();
  if (model.includes('codex')) return 'codex';
  if (model.startsWith('gpt-') || model.startsWith('o3') || model.startsWith('o4')) return 'gpt';
  if (model.includes('/')) return 'openrouter';
  // 로컬 모델 패턴: ollama 태그 형식 (name:tag) 또는 알려진 오픈소스 모델
  if (model.includes(':') || /^(gemma|llama|mistral|codestral|qwen|deepseek|phi|starcoder)/i.test(model)) return 'local';
  return getDefaultAdapterName();
}

export function getDefaultChatModel(provider: AdapterName): string {
  if (provider === 'codex') return 'gpt-5-codex';
  if (provider === 'codex-responses') return 'gpt-5.5';
  if (provider === 'gpt') return 'gpt-4o';
  if (provider === 'local') return 'gemma3:4b';
  if (provider === 'lmstudio') return process.env.LMSTUDIO_MODEL ?? 'local-model';
  if (provider === 'openrouter') return 'openai/gpt-5';
  return 'gpt-5-codex';
}

export function resolveChatModel(input: string | undefined, provider: AdapterName): string {
  if (!input) return getDefaultChatModel(provider);
  const alias = CHAT_MODEL_ALIASES[provider][input.toLowerCase()];
  return alias || input;
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
    enableTools: true,
    webTools: true,
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

        const response = extractCodexChatResponse(stdout);
        const cost = undefined;
        const tokens = undefined;

        resolve({
          response: response || '[No response]',
          provider,
          model,
          sessionId: capturedSessionId || undefined,
          cost,
          tokens,
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


