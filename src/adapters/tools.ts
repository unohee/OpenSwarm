// ============================================
// OpenSwarm - Agentic Tool Definitions & Executor
// Created: 2026-04-11
// Purpose: GPT/Local 어댑터가 Claude CLI와 동등한 도구 사용 능력을 갖도록
//          공통 도구 정의 + 실행기 제공
// ============================================

import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { webFetch, webSearch } from './webTools.js';
import { isMcpTool, callMcpTool } from '../mcp/mcpClient.js';

const execFileAsync = promisify(execFile);

// ============ 도구 정의 (OpenAI function calling 포맷) ============

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file and return its content. Use offset/limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path to read' },
          offset: { type: 'number', description: 'Start line (0-based). Default: 0' },
          limit: { type: 'number', description: 'Max lines to read. Default: 500' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file (creates or overwrites).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path' },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace a specific string in a file. old_string must be unique in the file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path' },
          old_string: { type: 'string', description: 'Exact string to find and replace' },
          new_string: { type: 'string', description: 'Replacement string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search file contents using ripgrep (regex). Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory or file to search in' },
          glob: { type: 'string', description: 'File glob filter (e.g., "*.ts")' },
        },
        required: ['pattern', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command and return stdout/stderr. Timeout: 30s. Destructive commands (rm -rf, git reset --hard) are blocked.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description:
        "Search this repository's accumulated knowledge from past tasks — successful approaches (patterns) and reviewer pitfalls (constraints) — by semantic query. Call this BEFORE implementing to reuse what worked here and avoid known mistakes. Scoped to the current repo automatically.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to recall, e.g. "how auth migrations were handled" or "logout button"' },
          limit: { type: 'number', description: 'Max results (1-10). Default: 5' },
        },
        required: ['query'],
      },
    },
  },
];

// ============ 안전 가드 ============

const BLOCKED_COMMANDS = [
  /\brm\s+(-[rR]f?|--recursive)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-fd\b/,
  /\bdrop\s+database\b/i,
  /\btruncate\s+table\b/i,
  /\bchmod\s+777\b/,
  /\bchown\s+-R\b/,
  />\s*\/dev\/sd/,
  /\bdd\s+if=/,
  /\bpkill\s+-9\b/,
  /\bkill\s+-9\b/,
];

function isCommandBlocked(command: string): boolean {
  return BLOCKED_COMMANDS.some(pattern => pattern.test(command));
}

// ============ 도구 실행기 ============

export interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;  // JSON string
  };
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
  is_error: boolean;
}

/**
 * 루프 단위 read 캐시. 같은 작업 루프 안에서 동일 파일을 반복 read하면
 * (모델이 edit 후 "고쳐졌나?" 확인하려 재read하는 패턴) 디스크를 다시 읽지 않고
 * 캐시된 내용 + "변경 없음" 힌트를 반환해 토큰·턴 낭비를 줄인다.
 * edit_file/write_file 성공 시 해당 경로를 무효화해 stale read를 막는다.
 *
 * LRU-bounded: a single 80-turn SWE run reading many offsets of large files
 * could otherwise retain megabytes of numbered content for the whole loop.
 * The Map preserves insertion order, so eviction drops the least-recently-used
 * key once MAX_READ_CACHE_ENTRIES is exceeded.
 */
const MAX_READ_CACHE_ENTRIES = 64;

export interface ReadCache {
  store: Map<string, string>;
}

export function createReadCache(): ReadCache {
  return { store: new Map() };
}

/** Cache read that bumps the key to most-recently-used. */
function cacheGet(cache: ReadCache, key: string): string | undefined {
  const value = cache.store.get(key);
  if (value === undefined) return undefined;
  // Re-insert to move to the end (MRU) so eviction targets truly-old entries.
  cache.store.delete(key);
  cache.store.set(key, value);
  return value;
}

/** Cache write with LRU eviction once the entry cap is exceeded. */
function cacheSet(cache: ReadCache, key: string, value: string): void {
  cache.store.delete(key);
  cache.store.set(key, value);
  while (cache.store.size > MAX_READ_CACHE_ENTRIES) {
    const oldest = cache.store.keys().next().value;
    if (oldest === undefined) break;
    cache.store.delete(oldest);
  }
}

/** 캐시에서 한 파일의 모든 범위 엔트리를 제거 (edit/write 후 stale 방지) */
function invalidateCache(cache: ReadCache | undefined, filePath: string): void {
  if (!cache) return;
  for (const key of cache.store.keys()) {
    if (key.startsWith(`${filePath}#`)) cache.store.delete(key);
  }
}

/**
 * Tool execution options — verification-harness protection.
 * Found in SWE hybrid runs: the implementer model misattributed test failures
 * to the verification script (run_tests.sh) and edited the script itself five
 * times, destroying verification integrity. Protected files reject edit/write.
 * The bash timeout is also configurable — the 30s default dies silently on
 * docker-based test runs (minutes), which made models conclude "the
 * environment is broken".
 */
export interface ToolExecOptions {
  /** Filenames (matched by path suffix) for which edit_file/write_file are refused */
  protectedFiles?: string[];
  /** bash tool timeout (default DEFAULT_BASH_TIMEOUT_MS) */
  bashTimeoutMs?: number;
}

const DEFAULT_BASH_TIMEOUT_MS = 30000;

function isProtected(resolved: string, protectedFiles?: string[]): boolean {
  if (!protectedFiles?.length) return false;
  return protectedFiles.some((p) => resolved === p || resolved.endsWith(`/${p}`));
}

/** 프로젝트 경로 내로 접근을 제한하는 경로 검증 */
function validatePath(filePath: string, cwd: string): string {
  const resolved = path.resolve(cwd, filePath);
  // cwd 하위이거나, /tmp 하위만 허용
  if (!resolved.startsWith(cwd) && !resolved.startsWith('/tmp')) {
    // 모델이 자가수정하도록 안내 — 그냥 거부만 하면 같은 실수를 반복한다.
    throw new Error(
      `Path "${filePath}" is outside the project root (${cwd}). ` +
      `Use a path relative to the project root instead, e.g. "." for the whole project or "src/...". ` +
      `Do not use "/" or absolute paths outside ${cwd}.`,
    );
  }
  return resolved;
}

/**
 * 단일 도구 호출 실행
 */
export async function executeTool(
  toolCall: ToolCall,
  cwd: string,
  cache?: ReadCache,
  execOptions?: ToolExecOptions,
): Promise<ToolResult> {
  const { name, arguments: argsJson } = toolCall.function;
  const callId = toolCall.id;

  try {
    const args = JSON.parse(argsJson);

    switch (name) {
      case 'read_file': {
        const filePath = validatePath(args.path, cwd);
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 500;
        const cacheKey = `${filePath}#${offset}:${limit}`;

        // 같은 루프에서 이미 같은 범위를 읽었으면 디스크 재접근 없이 캐시 반환.
        // 모델에게 "변경 없음"을 알려 추가 확인 read를 유도하지 않는다.
        const cached = cache ? cacheGet(cache, cacheKey) : undefined;
        if (cached !== undefined) {
          return {
            tool_call_id: callId,
            content: `(unchanged since last read — cached)\n${cached}`,
            is_error: false,
          };
        }

        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const slice = lines.slice(offset, offset + limit);
        const numbered = slice.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
        const truncated = lines.length > offset + limit
          ? `\n... (${lines.length - offset - limit} more lines)`
          : '';
        const result = numbered + truncated;
        if (cache) cacheSet(cache, cacheKey, result);
        return { tool_call_id: callId, content: result, is_error: false };
      }

      case 'write_file': {
        const filePath = validatePath(args.path, cwd);
        if (isProtected(filePath, execOptions?.protectedFiles)) {
          return {
            tool_call_id: callId,
            content: `PROTECTED: ${args.path} is part of the verification harness and must not be modified. ` +
              `If tests fail, the cause is in the SOURCE code (or your fix) — debug from the test output instead.`,
            is_error: true,
          };
        }
        // 디렉토리 자동 생성
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, args.content, 'utf-8');
        invalidateCache(cache, filePath);
        return { tool_call_id: callId, content: `Written: ${filePath}`, is_error: false };
      }

      case 'edit_file': {
        const filePath = validatePath(args.path, cwd);
        if (isProtected(filePath, execOptions?.protectedFiles)) {
          return {
            tool_call_id: callId,
            content: `PROTECTED: ${args.path} is part of the verification harness and must not be modified. ` +
              `If tests fail, the cause is in the SOURCE code (or your fix) — debug from the test output instead.`,
            is_error: true,
          };
        }
        const original = await fs.readFile(filePath, 'utf-8');
        const occurrences = original.split(args.old_string).length - 1;
        if (occurrences === 0) {
          return { tool_call_id: callId, content: `old_string not found in ${filePath}`, is_error: true };
        }
        if (occurrences > 1) {
          return { tool_call_id: callId, content: `old_string found ${occurrences} times — must be unique. Provide more context.`, is_error: true };
        }
        const updated = original.replace(args.old_string, args.new_string);
        await fs.writeFile(filePath, updated, 'utf-8');
        invalidateCache(cache, filePath);
        // Return the changed region so the model can verify without a re-read.
        // Locate the edit via old_string's position in the ORIGINAL (guaranteed
        // unique above) — indexOf(new_string) on the updated text could match an
        // earlier pre-existing occurrence and show the wrong region.
        const newLines = updated.split('\n');
        const editLine = original.slice(0, original.indexOf(args.old_string)).split('\n').length - 1;
        const from = Math.max(0, editLine - 3);
        const to = Math.min(newLines.length, editLine + args.new_string.split('\n').length + 3);
        const snippet = newLines.slice(from, to).map((l, i) => `${from + i + 1}\t${l}`).join('\n');
        return {
          tool_call_id: callId,
          content: `Edited: ${filePath}\nResulting region:\n${snippet}`,
          is_error: false,
        };
      }

      case 'search_files': {
        const searchPath = validatePath(args.path, cwd);
        const rgArgs = ['--no-heading', '--line-number', '--max-count', '50'];
        if (args.glob) {
          rgArgs.push('--glob', args.glob);
        }
        rgArgs.push(args.pattern, searchPath);

        try {
          const { stdout } = await execFileAsync('rg', rgArgs, { timeout: 10000, maxBuffer: 1024 * 256 });
          return { tool_call_id: callId, content: stdout || '(no matches)', is_error: false };
        } catch (err) {
          // rg exit code 1 = no matches
          if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 1) {
            return { tool_call_id: callId, content: '(no matches)', is_error: false };
          }
          throw err;
        }
      }

      case 'bash': {
        const command: string = args.command;
        if (isCommandBlocked(command)) {
          return { tool_call_id: callId, content: `BLOCKED: destructive command not allowed: ${command}`, is_error: true };
        }
        try {
          const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
            cwd,
            timeout: execOptions?.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS,
            maxBuffer: 1024 * 512,
            env: process.env,
          });
          const output = stdout + (stderr ? `\n[stderr] ${stderr}` : '');
          // 출력이 너무 길면 잘라냄
          return {
            tool_call_id: callId,
            content: output.length > 8000 ? output.slice(0, 8000) + '\n... (truncated)' : output || '(no output, exit 0)',
            is_error: false,
          };
        } catch (err) {
          // exit code != 0 → execFile이 throw. 하지만 grep/find 등은 "매치 없음"으로
          // exit 1을 내며 이건 정상이다. 실제 stdout/stderr + exit code를 모델에게 줘서
          // "no match"인지 진짜 에러인지 스스로 판단하게 한다(이게 없으면 같은 명령 반복).
          const e = err as { code?: number; stdout?: string; stderr?: string; message?: string; killed?: boolean; signal?: string };
          const out = (e.stdout ?? '') + (e.stderr ? `\n[stderr] ${e.stderr}` : '');
          const code = typeof e.code === 'number' ? e.code : '?';
          // Make timeout kills explicit — a silent no-output failure leads the
          // model to conclude "the verification environment is broken" and start
          // dismantling the harness (observed in SWE runs).
          if (e.killed && e.signal) {
            const limit = execOptions?.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
            return {
              tool_call_id: callId,
              content: `TIMEOUT: command exceeded ${Math.round(limit / 1000)}s and was killed (${e.signal}). ` +
                `The command may simply be slow — this is NOT evidence that the environment or script is broken. ` +
                `Partial output:\n${out.slice(0, 2000) || '(none)'}`,
              is_error: true,
            };
          }
          const body = out.trim()
            ? `exit ${code}:\n${out.slice(0, 4000)}`
            : `exit ${code} (no output) — likely no matches or a non-fatal nonzero exit, not necessarily an error.`;
          // exit 1 + 출력 없음은 보통 무해(grep no-match) → is_error를 false로 둬 모델이 안 헤매게.
          const benign = e.code === 1 && !out.trim();
          return { tool_call_id: callId, content: body, is_error: !benign };
        }
      }

      case 'search_memory': {
        const query = String(args.query ?? '').trim();
        if (!query) {
          return { tool_call_id: callId, content: 'search_memory requires a non-empty "query".', is_error: true };
        }
        try {
          // Loaded lazily: the memory core pulls in LanceDB + the embedding model,
          // which we don't want as a static dependency of every tools.ts consumer.
          const [{ searchMemorySafe }, { repoKey }] = await Promise.all([
            import('../memory/index.js'),
            import('../memory/repoKnowledge.js'),
          ]);
          const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
          const res = await searchMemorySafe(query, {
            repo: repoKey(cwd),
            types: ['system_pattern', 'constraint', 'fact', 'strategy', 'belief'],
            limit,
            minSimilarity: 0.3,
          });
          if (!res.success) {
            return { tool_call_id: callId, content: `Memory unavailable (${res.errorCode ?? 'unknown'}); proceed without it.`, is_error: false };
          }
          if (res.memories.length === 0) {
            return { tool_call_id: callId, content: 'No matching repo knowledge yet for this query.', is_error: false };
          }
          const formatted = res.memories
            .map((m) => `- [${m.type}] ${m.title}\n  ${m.content.replace(/\s+/g, ' ').slice(0, 300)}`)
            .join('\n');
          return { tool_call_id: callId, content: `Repository knowledge (${res.memories.length}):\n${formatted}`, is_error: false };
        } catch (err) {
          return { tool_call_id: callId, content: `search_memory failed: ${err instanceof Error ? err.message : String(err)}`, is_error: false };
        }
      }

      case 'web_fetch': {
        const text = await webFetch(args.url);
        return { tool_call_id: callId, content: text, is_error: text.startsWith('Invalid URL') || text.startsWith('Fetch ') };
      }

      case 'web_search': {
        const text = await webSearch(args.query, args.max_results);
        return { tool_call_id: callId, content: text, is_error: text.startsWith('Search failed') || text.startsWith('Invalid query') };
      }

      default:
        // MCP tools (named `server__tool`) route to their server via the MCP client.
        if (isMcpTool(name)) {
          const text = await callMcpTool(name, (args ?? {}) as Record<string, unknown>);
          return {
            tool_call_id: callId,
            content: text,
            is_error: text.startsWith('MCP error') || text.startsWith('MCP tool not registered'),
          };
        }
        return { tool_call_id: callId, content: `Unknown tool: ${name}`, is_error: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { tool_call_id: callId, content: `Tool error: ${msg}`, is_error: true };
  }
}

/**
 * 여러 도구 호출을 병렬 실행
 */
export async function executeToolCalls(
  toolCalls: ToolCall[],
  cwd: string,
  cache?: ReadCache,
  execOptions?: ToolExecOptions,
): Promise<ToolResult[]> {
  return Promise.all(toolCalls.map(tc => executeTool(tc, cwd, cache, execOptions)));
}
