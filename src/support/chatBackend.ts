import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import type { AdapterName } from '../adapters/index.js';
import { getAdapter } from '../adapters/index.js';
import { getDefaultAdapterName } from '../adapters/index.js';
import { extractResultFromStreamJson } from '../agents/cliStreamParser.js';
import { extractCostFromStreamJson } from './costTracker.js';

export interface ChatCompletionOptions {
  prompt: string;
  provider?: AdapterName;
  model?: string;
  cwd?: string;
  sessionId?: string;
  timeoutMs?: number;
  onText?: (text: string, isThinking: boolean) => void;
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
  claude: {
    sonnet: 'claude-sonnet-4-5-20250929',
    haiku: 'claude-haiku-4-5-20251001',
    opus: 'claude-opus-4-6',
  },
  codex: {
    codex: 'gpt-5-codex',
    gpt5: 'gpt-5-codex',
    gpt5codex: 'gpt-5-codex',
  },
};

export function inferProviderFromModel(model?: string): AdapterName {
  if (!model) return getDefaultAdapterName();
  return model.startsWith('gpt-') || model.includes('codex') ? 'codex' : 'claude';
}

export function getDefaultChatModel(provider: AdapterName): string {
  return provider === 'codex'
    ? 'gpt-5-codex'
    : 'claude-sonnet-4-5-20250929';
}

export function resolveChatModel(input: string | undefined, provider: AdapterName): string {
  if (!input) return getDefaultChatModel(provider);
  const alias = CHAT_MODEL_ALIASES[provider][input.toLowerCase()];
  return alias || input;
}

export function shortenChatModel(model: string): string {
  if (model.startsWith('claude-')) {
    return model.replace('claude-', '').replace(/-\d{8}$/, '');
  }
  return model;
}

export async function runChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const provider = options.provider ?? inferProviderFromModel(options.model);
  const model = resolveChatModel(options.model, provider);
  const adapter = getAdapter(provider);
  const cwd = options.cwd ?? process.cwd();
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
            if (provider === 'claude') {
              if (event.session_id && !capturedSessionId) {
                capturedSessionId = event.session_id;
              }
              if (event.type === 'assistant' && event.message?.content) {
                for (const block of event.message.content) {
                  if (block.type === 'text' && block.text) {
                    startedStreaming = true;
                    options.onText?.(block.text, false);
                    resetThinkingTimer();
                  }
                }
              }
            } else {
              if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
                startedStreaming = true;
                options.onText?.(event.item.text, false);
                resetThinkingTimer();
              }
              if (event.type === 'item.completed' && event.item?.type === 'reasoning') {
                options.onText?.('', true);
              }
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

        const response = provider === 'claude'
          ? extractClaudeChatResponse(stdout)
          : extractCodexChatResponse(stdout);
        const cost = provider === 'claude' ? extractCostFromStreamJson(stdout)?.costUsd : undefined;
        const tokens = provider === 'claude' ? extractClaudeTokens(stdout) : undefined;

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

function extractClaudeChatResponse(stdout: string): string {
  const resultText = extractResultFromStreamJson(stdout);
  if (resultText?.trim()) return resultText.trim();

  const assistantTexts: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text?.trim()) {
            assistantTexts.push(block.text.trim());
          }
        }
      }
    } catch {
      // Ignore malformed lines.
    }
  }
  return assistantTexts.join('\n\n').trim();
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

function extractClaudeTokens(stdout: string): number | undefined {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event.type === 'result') {
        return (event.input_tokens ?? 0) + (event.output_tokens ?? 0);
      }
    } catch {
      // Ignore malformed lines.
    }
  }
  return undefined;
}
