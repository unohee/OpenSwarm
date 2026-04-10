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

/** 프로젝트 경로 내로 접근을 제한하는 경로 검증 */
function validatePath(filePath: string, cwd: string): string {
  const resolved = path.resolve(cwd, filePath);
  // cwd 하위이거나, /tmp 하위만 허용
  if (!resolved.startsWith(cwd) && !resolved.startsWith('/tmp')) {
    throw new Error(`Path outside project: ${resolved} (cwd: ${cwd})`);
  }
  return resolved;
}

/**
 * 단일 도구 호출 실행
 */
export async function executeTool(
  toolCall: ToolCall,
  cwd: string,
): Promise<ToolResult> {
  const { name, arguments: argsJson } = toolCall.function;
  const callId = toolCall.id;

  try {
    const args = JSON.parse(argsJson);

    switch (name) {
      case 'read_file': {
        const filePath = validatePath(args.path, cwd);
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 500;
        const slice = lines.slice(offset, offset + limit);
        const numbered = slice.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
        const truncated = lines.length > offset + limit
          ? `\n... (${lines.length - offset - limit} more lines)`
          : '';
        return { tool_call_id: callId, content: numbered + truncated, is_error: false };
      }

      case 'write_file': {
        const filePath = validatePath(args.path, cwd);
        // 디렉토리 자동 생성
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, args.content, 'utf-8');
        return { tool_call_id: callId, content: `Written: ${filePath}`, is_error: false };
      }

      case 'edit_file': {
        const filePath = validatePath(args.path, cwd);
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
        return { tool_call_id: callId, content: `Edited: ${filePath}`, is_error: false };
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
            timeout: 30000,
            maxBuffer: 1024 * 512,
            env: process.env,
          });
          const output = stdout + (stderr ? `\n[stderr] ${stderr}` : '');
          // 출력이 너무 길면 잘라냄
          return {
            tool_call_id: callId,
            content: output.length > 8000 ? output.slice(0, 8000) + '\n... (truncated)' : output,
            is_error: false,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { tool_call_id: callId, content: `Command failed: ${msg.slice(0, 2000)}`, is_error: true };
        }
      }

      default:
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
): Promise<ToolResult[]> {
  return Promise.all(toolCalls.map(tc => executeTool(tc, cwd)));
}
