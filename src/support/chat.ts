#!/usr/bin/env tsx
// ============================================
// OpenSwarm - Interactive Chat CLI
// Interactive chat interface for CLI agent command center
// Backend: Claude/Codex via shared chat adapter backend

import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadConfig } from '../core/config.js';
import { getDefaultAdapterName, type AdapterName } from '../adapters/index.js';
import { getDefaultChatModel, resolveChatModel, runChatCompletion, shortenChatModel } from './chatBackend.js';

const CHAT_DIR = resolve(homedir(), '.openswarm', 'chat');

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

type Message = { role: 'user' | 'assistant'; content: string };

type Session = {
  id: string;
  provider: AdapterName;
  model: string;
  messages: Message[];
  claudeSessionId?: string;
  createdAt: string;
  updatedAt: string;
};

async function ensureChatDir(): Promise<void> {
  await mkdir(CHAT_DIR, { recursive: true });
}

async function saveSession(session: Session): Promise<void> {
  await ensureChatDir();
  session.updatedAt = new Date().toISOString();
  const path = resolve(CHAT_DIR, `${session.id}.json`);
  await writeFile(path, JSON.stringify(session, null, 2));
}

async function loadSession(id: string): Promise<Session | null> {
  const path = resolve(CHAT_DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(await readFile(path, 'utf-8')) as Partial<Session>;
  const provider = inferProvider(raw.provider, raw.model);
  return {
    id: raw.id || id,
    provider,
    model: raw.model || getDefaultChatModel(provider),
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    claudeSessionId: raw.claudeSessionId,
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
}

async function listSessions(): Promise<string[]> {
  await ensureChatDir();
  const files = await readdir(CHAT_DIR);
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''));
}

function generateSessionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

async function chat(session: Session, userMessage: string): Promise<void> {
  session.messages.push({ role: 'user', content: userMessage });

  try {
    process.stdout.write(`\n${GREEN}${BOLD}${session.provider}${RESET} `);
    const result = await runChatCompletion({
      prompt: userMessage,
      provider: session.provider,
      model: session.model,
      sessionId: session.provider === 'claude' ? session.claudeSessionId : undefined,
      onText: (text, isThinking) => {
        if (!isThinking) process.stdout.write(text);
      },
    });
    process.stdout.write('\n\n');

    if (session.provider === 'claude' && result.sessionId) {
      session.claudeSessionId = result.sessionId;
    }

    if (result.response) {
      session.messages.push({ role: 'assistant', content: result.response });
    } else {
      session.messages.pop();
    }

    await saveSession(session);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${RED}Error: ${msg}${RESET}\n`);
    session.messages.pop();
  }
}

async function handleCommand(
  cmd: string,
  session: Session,
): Promise<'exit' | 'handled'> {
  const [command, ...args] = cmd.slice(1).split(' ');

  switch (command) {
    case 'exit':
    case 'quit':
    case 'q':
      await saveSession(session);
      return 'exit';

    case 'clear':
    case 'c':
      session.messages = [];
      session.claudeSessionId = undefined;
      console.log(`${GREEN}Conversation cleared.${RESET}`);
      return 'handled';

    case 'save': {
      const name = args[0] || session.id;
      session.id = name;
      await saveSession(session);
      console.log(`${GREEN}Saved: ${name}${RESET}`);
      return 'handled';
    }

    case 'load': {
      const name = args[0];
      if (!name) {
        const sessions = await listSessions();
        if (sessions.length === 0) {
          console.log(`${DIM}No saved sessions.${RESET}`);
        } else {
          console.log(`${BOLD}Sessions:${RESET}`);
          for (const s of sessions.slice(-10)) {
            const data = await loadSession(s);
            const msgCount = data?.messages.length ?? 0;
            const hasResume = data?.claudeSessionId ? ' (resumable)' : '';
            const provider = data?.provider ?? inferProvider(undefined, data?.model);
            console.log(`  ${CYAN}${s}${RESET} ${msgCount} msgs ${DIM}[${provider}]${RESET}${hasResume}`);
          }
        }
        return 'handled';
      }
      const loaded = await loadSession(name);
      if (!loaded) {
        console.log(`${RED}Not found: ${name}${RESET}`);
        return 'handled';
      }
      Object.assign(session, loaded);
      console.log(`${GREEN}Loaded: ${name} (${loaded.messages.length} msgs)${RESET}`);
      return 'handled';
    }

    case 'provider': {
      const next = args[0];
      if (!next) {
        console.log(`${BOLD}Provider:${RESET} ${session.provider}`);
        console.log(`${DIM}  claude | codex${RESET}`);
        return 'handled';
      }
      if (next !== 'claude' && next !== 'codex') {
        console.log(`${RED}Unknown provider: ${next}${RESET}`);
        return 'handled';
      }
      session.provider = next;
      session.model = getDefaultChatModel(next);
      session.claudeSessionId = undefined;
      console.log(`${GREEN}Provider: ${session.provider}${RESET}`);
      console.log(`${GREEN}Model: ${session.model}${RESET}`);
      return 'handled';
    }

    case 'model': {
      const newModel = args[0];
      if (!newModel) {
        console.log(`${BOLD}Provider:${RESET} ${session.provider}`);
        console.log(`${BOLD}Model:${RESET} ${session.model}`);
        if (session.provider === 'claude') {
          console.log(`${DIM}  sonnet → claude-sonnet-4-5-20250929${RESET}`);
          console.log(`${DIM}  haiku  → claude-haiku-4-5-20251001${RESET}`);
          console.log(`${DIM}  opus   → claude-opus-4-6${RESET}`);
        } else {
          console.log(`${DIM}  codex  → gpt-5-codex${RESET}`);
        }
        return 'handled';
      }
      session.model = resolveChatModel(newModel, session.provider);
      session.claudeSessionId = undefined;
      console.log(`${GREEN}Model: ${session.model}${RESET}`);
      return 'handled';
    }

    case 'info':
    case 'status':
      console.log(`${BOLD}Session:${RESET} ${session.id}`);
      console.log(`${BOLD}Provider:${RESET} ${session.provider}`);
      console.log(`${BOLD}Model:${RESET} ${session.model}`);
      console.log(`${BOLD}Messages:${RESET} ${session.messages.length}`);
      console.log(`${BOLD}Claude resume:${RESET} ${session.claudeSessionId ? 'active' : 'none'}`);
      return 'handled';

    case 'help':
    case 'h':
    case '?':
      console.log(`
${BOLD}Commands:${RESET}
  ${CYAN}/clear${RESET}            Clear conversation
  ${CYAN}/save [name]${RESET}      Save session
  ${CYAN}/load [name]${RESET}      List/load sessions
  ${CYAN}/provider [id]${RESET}    Change provider (claude/codex)
  ${CYAN}/model [id]${RESET}       Change model
  ${CYAN}/info${RESET}             Session info
  ${CYAN}/exit${RESET}             Exit (Ctrl+D)

${BOLD}Multiline:${RESET}  ${CYAN}"""${RESET} start → ${CYAN}"""${RESET} end
`);
      return 'handled';

    default:
      console.log(`${RED}Unknown: /${command}${RESET} (/help)`);
      return 'handled';
  }
}

async function main(): Promise<void> {
  const defaultProvider = loadDefaultProvider();
  const loadArg = process.argv[2];
  let session: Session;

  if (loadArg && loadArg !== '--') {
    const loaded = await loadSession(loadArg);
    if (loaded) {
      session = loaded;
      console.log(`${GREEN}Resumed: ${loadArg} (${loaded.messages.length} msgs)${RESET}`);
    } else {
      session = createSession(loadArg, defaultProvider);
    }
  } else {
    session = createSession(generateSessionId(), defaultProvider);
  }

  const shortModel = shortenChatModel(session.model);
  console.log(`${BOLD}╔════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║${RESET}  Swarm Chat  ${DIM}${session.provider}:${shortModel}${RESET}`);
  console.log(`${BOLD}╚════════════════════════════════════╝${RESET}`);
  console.log(`${DIM}${session.id} | /help | Ctrl+D exit${RESET}\n`);

  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  rl.on('SIGINT', () => process.stdout.write('\n'));

  const prompt = `${CYAN}${BOLD}you${RESET} `;

  while (true) {
    let input: string;
    try {
      input = await rl.question(prompt);
    } catch {
      break;
    }

    const trimmed = input.trim();
    if (!trimmed) continue;

    if (trimmed === '"""' || trimmed === "'''") {
      const delim = trimmed;
      const lines: string[] = [];
      console.log(`${DIM}(multiline — ${delim} to end)${RESET}`);
      while (true) {
        let line: string;
        try {
          line = await rl.question(`${DIM}...${RESET} `);
        } catch {
          break;
        }
        if (line.trim() === delim) break;
        lines.push(line);
      }
      if (lines.length > 0) await chat(session, lines.join('\n'));
      continue;
    }

    if (trimmed.startsWith('/')) {
      if (await handleCommand(trimmed, session) === 'exit') break;
      continue;
    }

    await chat(session, trimmed);
  }

  await saveSession(session);
  console.log(`\n${DIM}Saved: ${session.id}${RESET}`);
  rl.close();
  process.exit(0);
}

function createSession(id: string, provider: AdapterName): Session {
  return {
    id,
    provider,
    model: getDefaultChatModel(provider),
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function inferProvider(provider?: AdapterName, model?: string): AdapterName {
  if (provider) return provider;
  if (model?.startsWith('gpt-') || model?.includes('codex')) return 'codex';
  return loadDefaultProvider();
}

function loadDefaultProvider(): AdapterName {
  try {
    return loadConfig().adapter ?? getDefaultAdapterName();
  } catch {
    return getDefaultAdapterName();
  }
}

main().catch((err) => {
  console.error(`${RED}Fatal: ${err.message || err}${RESET}`);
  process.exit(1);
});
