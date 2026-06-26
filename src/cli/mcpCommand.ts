// ============================================
// OpenSwarm - `openswarm mcp add|list|remove` (INT-1953)
// ============================================
//
// Manage MCP servers in ~/.openswarm/mcp.json from the CLI instead of editing
// the JSON by hand. The mutation helpers are pure (registry in → registry out)
// so routing is unit-tested; runMcpCommand is the thin read→mutate→write shell.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { McpServerConfig } from '../core/types.js';
import { BUILTIN_MCP_SERVERS } from '../mcp/mcpClient.js';

export const MCP_JSON_PATH = join(homedir(), '.openswarm', 'mcp.json');

export interface McpJson {
  mcpServers: Record<string, McpServerConfig>;
}

export function readMcpJson(path = MCP_JSON_PATH): McpJson {
  if (!existsSync(path)) return { mcpServers: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, McpServerConfig> };
    return { mcpServers: parsed.mcpServers ?? {} };
  } catch {
    return { mcpServers: {} };
  }
}

export function writeMcpJson(json: McpJson, path = MCP_JSON_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

/**
 * Turn `add` arguments into a server spec: a `--preset`, an http(s) URL (remote),
 * or a command + args (stdio).
 */
export function parseServerSpec(target: string | undefined, args: string[], preset?: string): McpServerConfig {
  if (preset) return { preset };
  if (target && /^https?:\/\//.test(target)) return { url: target };
  if (target) return { command: target, ...(args.length ? { args } : {}) };
  throw new Error('mcp add: provide a --preset, a URL, or a command');
}

export function addServer(json: McpJson, name: string, spec: McpServerConfig): McpJson {
  return { mcpServers: { ...json.mcpServers, [name]: spec } };
}

export function removeServer(json: McpJson, name: string): McpJson {
  const next = { ...json.mcpServers };
  delete next[name];
  return { mcpServers: next };
}

export function formatServerList(json: McpJson): string {
  const names = Object.keys(json.mcpServers);
  if (!names.length) {
    const presets = Object.keys(BUILTIN_MCP_SERVERS).join(', ');
    return `No MCP servers configured. Add one with \`openswarm mcp add <name> --preset <${presets}>\` or a command/URL.`;
  }
  return names
    .map((n) => {
      const s = json.mcpServers[n];
      const detail = s.preset
        ? `preset:${s.preset}`
        : s.url
          ? s.url
          : `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim();
      return `  ${n} — ${detail}`;
    })
    .join('\n');
}

export interface McpCommandOptions {
  preset?: string;
  path?: string;
}

/** Thin I/O shell: read mcp.json → mutate → write. Returns the message to print. */
export function runMcpCommand(
  action: string,
  name: string | undefined,
  args: string[],
  opts: McpCommandOptions = {},
): string {
  const path = opts.path ?? MCP_JSON_PATH;
  const json = readMcpJson(path);

  switch (action) {
    case 'list':
      return formatServerList(json);

    case 'add': {
      if (!name) throw new Error('mcp add: a server name is required');
      const spec = parseServerSpec(args[0], args.slice(1), opts.preset);
      writeMcpJson(addServer(json, name, spec), path);
      return `Added MCP server "${name}". It is now available to the worker/CLI.`;
    }

    case 'remove': {
      if (!name) throw new Error('mcp remove: a server name is required');
      if (!json.mcpServers[name]) return `No MCP server named "${name}".`;
      writeMcpJson(removeServer(json, name), path);
      return `Removed MCP server "${name}".`;
    }

    default:
      throw new Error(`Unknown mcp action "${action}" (use add|list|remove)`);
  }
}
