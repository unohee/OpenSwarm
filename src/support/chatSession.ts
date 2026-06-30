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
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadConfig } from '../core/config.js';
import { getDefaultAdapterName, isKnownAdapter, type AdapterName } from '../adapters/index.js';
import { getDefaultChatModel, runChatCompletion } from './chatBackend.js';

/**
 * On-disk location for persisted chat sessions. Read via OPENSWARM_CHAT_DIR when
 * set (lets tests redirect writes away from the real home dir). Evaluated per
 * call so the env override applies even after module load. (INT-2014)
 */
export function getChatDir(): string {
  return process.env.OPENSWARM_CHAT_DIR ?? resolve(homedir(), '.openswarm', 'chat');
}

/** Default chat-session dir at module-load time (back-compat for direct imports). */
export const CHAT_DIR = getChatDir();

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

export async function ensureChatDir(dir: string = getChatDir()): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function saveSession(session: Session, dir: string = getChatDir()): Promise<void> {
  await ensureChatDir(dir);
  session.updatedAt = new Date().toISOString();
  await writeFile(resolve(dir, `${session.id}.json`), JSON.stringify(session, null, 2));
}

export async function loadSession(id: string, dir: string = getChatDir()): Promise<Session | null> {
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
    // Older session files may predate the messages field — default to [] so
    // messagesToHistory never sees undefined. (INT-2014)
    messages: Array.isArray(data.messages) ? data.messages : [],
    totalCost: data.totalCost ?? 0,
    totalTokens: data.totalTokens ?? 0,
  };
}

export function generateSessionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export interface SessionMeta {
  id: string;
  mtimeMs: number;
}

/**
 * List persisted sessions, most-recently-modified first. Sorted by file mtime
 * rather than the id (generateSessionId is minute-granular, so ids collide and
 * sort poorly). Returns [] if the dir doesn't exist yet. (INT-2014)
 */
export async function listSessions(dir: string = getChatDir()): Promise<SessionMeta[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const metas: SessionMeta[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = await stat(resolve(dir, f));
      metas.push({ id: f.slice(0, -'.json'.length), mtimeMs: s.mtimeMs });
    } catch {
      // unreadable / removed mid-scan — skip
    }
  }
  return metas.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Id of the most recently modified session, or null if there are none. (INT-2014) */
export async function latestSession(dir: string = getChatDir()): Promise<string | null> {
  const list = await listSessions(dir);
  return list.length > 0 ? list[0].id : null;
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
  // Working directory the agent's tools (file/bash/MCP) operate in, and the root
  // used to build the repo context block. Defaults to process.cwd() downstream
  // when omitted — but the chat TUI threads the launch cwd through so the agent
  // works in the repo `openswarm chat` was started from. (INT-2005)
  cwd?: string,
): Promise<{ response: string; sessionId: string; cost: number; tokens: number }> {
  const result = await runChatCompletion({
    prompt,
    provider,
    model,
    cwd,
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
