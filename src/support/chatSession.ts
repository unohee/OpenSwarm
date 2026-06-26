// ============================================
// OpenSwarm - Chat session core (UI-agnostic)
// Extracted from chatTui.ts (EPIC INT-1813 S2 / INT-1935): session persistence,
// provider/model resolution, and the model-call wrapper — none of which touch
// blessed or ink. The Ink front-end (S4) and the existing blessed TUI both build
// on this. The session directory is injectable (PlanIO-style) so the logic is
// testable without writing to the real home directory.
// ============================================

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadConfig } from '../core/config.js';
import { getDefaultAdapterName, isKnownAdapter, type AdapterName } from '../adapters/index.js';
import { getDefaultChatModel, runChatCompletion } from './chatBackend.js';

/** Default on-disk location for persisted chat sessions. */
export const CHAT_DIR = resolve(homedir(), '.openswarm', 'chat');

export type Message = { role: 'user' | 'assistant'; content: string; cost?: number };

export type Session = {
  id: string;
  provider: AdapterName;
  model: string;
  messages: Message[];
  totalCost: number;
  totalTokens: number;
  createdAt: string;
  updatedAt: string;
  /** Session goal set via /goal; the agent pursues it autonomously. */
  goal?: string;
};

// Session persistence

export async function ensureChatDir(dir: string = CHAT_DIR): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function saveSession(session: Session, dir: string = CHAT_DIR): Promise<void> {
  await ensureChatDir(dir);
  session.updatedAt = new Date().toISOString();
  await writeFile(resolve(dir, `${session.id}.json`), JSON.stringify(session, null, 2));
}

export async function loadSession(id: string, dir: string = CHAT_DIR): Promise<Session | null> {
  const path = resolve(dir, `${id}.json`);
  if (!existsSync(path)) return null;
  const data = JSON.parse(await readFile(path, 'utf-8'));
  // Validate the persisted provider — a stale/removed adapter (e.g. `claude`)
  // must not pass through, or downstream model lookups crash. If it's replaced,
  // its model no longer applies → use the provider's default.
  const provider = inferProvider(data.provider, data.model);
  const model = data.provider === provider && data.model ? data.model : getDefaultChatModel(provider);
  return {
    ...data,
    provider,
    model,
    totalCost: data.totalCost ?? 0,
    totalTokens: data.totalTokens ?? 0,
  };
}

export function generateSessionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

// Provider / model resolution

export function inferProvider(provider?: AdapterName, model?: string): AdapterName {
  if (provider && isKnownAdapter(provider)) return provider;
  if (model?.startsWith('gpt-') || model?.includes('codex')) return 'codex';
  return loadDefaultProvider();
}

export function loadDefaultProvider(): AdapterName {
  try {
    return loadConfig().adapter ?? getDefaultAdapterName();
  } catch {
    return getDefaultAdapterName();
  }
}

// Model call wrapper

export async function callChatModel(
  prompt: string,
  provider: AdapterName,
  model: string,
  onStream: (text: string, isThinking: boolean) => void,
  onToolLog?: (line: string) => void,
  maxTurns?: number,
  signal?: AbortSignal,
): Promise<{ response: string; sessionId: string; cost: number; tokens: number }> {
  const result = await runChatCompletion({
    prompt,
    provider,
    model,
    timeoutMs: 300000,
    onText: onStream,
    onLog: onToolLog,
    maxTurns,
    signal,
  });

  return {
    response: result.response,
    sessionId: result.sessionId ?? '',
    cost: result.cost ?? 0,
    tokens: result.tokens ?? 0,
  };
}
