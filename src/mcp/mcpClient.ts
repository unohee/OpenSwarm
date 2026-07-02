// ============================================
// OpenSwarm - MCP client
// ============================================
//
// Exposes any MCP server listed in ~/.openswarm/mcp.json to the agentic loop as
// tools, so chat / the pipeline can call them like native tools. Mirrors
// vega-agent pipeline/mcp_client.py: registry → transport (stdio/http/sse) →
// initMcpTools (per-server listTools, qualified name `server__tool`) →
// callMcpTool dispatch → isMcpTool. Connections are per-call (like vega's
// `async with Client`); unreachable servers degrade with a log, never crash.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolDefinition } from '../adapters/tools.js';

/** Qualified tool name separator: `<server>__<tool>`. */
const SEP = '__';
const MCP_JSON_PATH = join(homedir(), '.openswarm', 'mcp.json');
const MCP_STDIO_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
]);
const MAX_MCP_TOOL_RESULT_CHARS = 20_000;

interface ServerConfig {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * Built-in MCP server presets — referenced by `{ preset: '<name>' }` in
 * config.yaml / mcp.json so common servers don't need hand-written commands.
 * `linear` gives the worker/CLI Linear access (issue read, comment, sub-issue
 * create) via the official remote MCP server. (INT-1952)
 */
export const BUILTIN_MCP_SERVERS: Record<string, ServerConfig> = {
  linear: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://mcp.linear.app/mcp'],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A persisted entry: `{preset}`, `{command,args,env}` (stdio) or `{url,headers,transport?}` (remote). */
function normalizeEntry(raw: unknown): ServerConfig | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.preset === 'string' && raw.preset) {
    return BUILTIN_MCP_SERVERS[raw.preset] ?? null;
  }
  if (typeof raw.command === 'string' && raw.command) {
    return {
      transport: 'stdio',
      command: raw.command,
      args: Array.isArray(raw.args) ? (raw.args as string[]) : [],
      env: (raw.env as Record<string, string>) ?? undefined,
    };
  }
  if (typeof raw.url === 'string' && raw.url) {
    const t = raw.transport === 'sse' ? 'sse' : 'http';
    return { transport: t, url: raw.url, headers: (raw.headers as Record<string, string>) ?? undefined };
  }
  return null;
}

/** Read ~/.openswarm/mcp.json → { serverName: ServerConfig }. */
export function loadRegistry(path = MCP_JSON_PATH): Record<string, ServerConfig> {
  if (!existsSync(path)) return {};
  let parsed: { mcpServers?: Record<string, Record<string, unknown>> };
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
  const servers = parsed.mcpServers ?? {};
  const out: Record<string, ServerConfig> = {};
  for (const [name, raw] of Object.entries(servers)) {
    const cfg = normalizeEntry(raw);
    if (cfg) out[name] = cfg;
  }
  return out;
}

/**
 * Normalize MCP servers declared in config.yaml (`mcp.servers`) into the same
 * registry shape loadRegistry produces. Invalid entries are dropped. (INT-1949)
 */
export function registryFromConfigServers(
  servers: Record<string, Record<string, unknown>> | undefined,
): Record<string, ServerConfig> {
  const out: Record<string, ServerConfig> = {};
  for (const [name, raw] of Object.entries(servers ?? {})) {
    const cfg = normalizeEntry(raw);
    if (cfg) out[name] = cfg;
  }
  return out;
}

/**
 * The effective MCP registry = ~/.openswarm/mcp.json merged with the servers
 * declared in config.yaml. Config entries win on name collision (config.yaml is
 * the source of truth the user edits). (INT-1949)
 */
export function loadEffectiveRegistry(
  configServers?: Record<string, Record<string, unknown>>,
  path = MCP_JSON_PATH,
): Record<string, ServerConfig> {
  return { ...loadRegistry(path), ...registryFromConfigServers(configServers) };
}

function makeTransport(cfg: ServerConfig) {
  if (cfg.transport === 'stdio') {
    return new StdioClientTransport({
      command: cfg.command!,
      args: cfg.args ?? [],
      env: { ...safeInheritedEnv(), ...cfg.env },
    });
  }
  const url = new URL(cfg.url!);
  const init = cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined;
  return cfg.transport === 'sse' ? new SSEClientTransport(url, init) : new StreamableHTTPClientTransport(url, init);
}

function safeInheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of MCP_STDIO_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

async function withClient<T>(cfg: ServerConfig, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'openswarm', version: '0.7.0' }, { capabilities: {} });
  try {
    await client.connect(makeTransport(cfg));
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** A qualified MCP tool name carries the `__` separator. */
export function isMcpTool(name: string): boolean {
  const parts = name.split(SEP);
  return parts.length === 2 && parts.every(isValidToolNameSegment) && isValidToolName(name);
}

function isValidToolNameSegment(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

function isValidToolName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name);
}

// Resolved at initMcpTools(); callMcpTool() looks the server up here.
let serverByTool: Record<string, { cfg: ServerConfig; toolName: string }> = {};

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Connect to every registered server, list its tools, and return them as
 * agentic-loop ToolDefinitions named `server__tool`. Unreachable servers are
 * skipped (logged). Call once before running the loop.
 */
export async function initMcpTools(registry = loadRegistry()): Promise<ToolDefinition[]> {
  serverByTool = {};
  const defs: ToolDefinition[] = [];
  for (const [server, cfg] of Object.entries(registry)) {
    try {
      const listed = (await withClient(cfg, (c) => c.listTools())) as { tools?: McpTool[] };
      for (const tool of listed.tools ?? []) {
        if (typeof tool.name !== 'string') continue;
        const qualified = `${server}${SEP}${tool.name}`;
        if (!isMcpTool(qualified)) {
          console.warn(`[MCP] server "${server}" returned invalid tool name "${tool.name}" — skipped`);
          continue;
        }
        serverByTool[qualified] = { cfg, toolName: tool.name };
        defs.push({
          type: 'function',
          function: {
            name: qualified,
            description: (tool.description ?? '').slice(0, 1024),
            parameters: tool.inputSchema ?? { type: 'object', properties: {} },
          },
        });
      }
    } catch (err) {
      console.warn(`[MCP] server "${server}" unreachable — skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return defs;
}

// Cache the discovered tools so chat doesn't re-list every message.
let cachedTools: ToolDefinition[] | null = null;

/**
 * The effective registry for auto-discovery: mcp.json merged with the servers
 * declared in config.yaml (`mcp.servers`, INT-1949). config is loaded lazily so
 * mcpClient stays free of a static dependency on core/config. (INT-1951)
 */
async function loadConfiguredRegistry(): Promise<Record<string, ServerConfig>> {
  let configServers: Record<string, Record<string, unknown>> | undefined;
  try {
    const { loadConfig } = await import('../core/config.js');
    configServers = loadConfig().mcp?.servers as Record<string, Record<string, unknown>> | undefined;
  } catch {
    // No/invalid config → fall back to mcp.json only.
  }
  return loadEffectiveRegistry(configServers);
}

/**
 * Discovered MCP tools (cached). Sources from mcp.json + config.yaml mcp.servers.
 * Empty when nothing is configured / no reachable servers. (INT-1951)
 */
export async function getMcpTools(): Promise<ToolDefinition[]> {
  if (cachedTools) return cachedTools;
  cachedTools = await initMcpTools(await loadConfiguredRegistry());
  return cachedTools;
}

/** Drop the cache (after editing mcp.json). */
export function resetMcpTools(): void {
  cachedTools = null;
}

/**
 * Resolve the MCP tools for an adapter run: use the caller-provided set if any,
 * otherwise self-source from the registry. A failing source degrades to no
 * tools (never blocks the run). `source` is injectable for tests. (INT-1951)
 */
export async function resolveMcpTools(
  provided?: ToolDefinition[],
  source: () => Promise<ToolDefinition[]> = getMcpTools,
): Promise<ToolDefinition[]> {
  if (provided) return provided;
  try {
    return await source();
  } catch {
    return [];
  }
}

/** Execute a `server__tool` call against its MCP server. Returns text content. */
export async function callMcpTool(qualified: string, args: Record<string, unknown>): Promise<string> {
  const entry = serverByTool[qualified];
  if (!entry) return `MCP tool not registered: ${qualified}`;
  try {
    const result = (await withClient(entry.cfg, (c) =>
      c.callTool({ name: entry.toolName, arguments: args }),
    )) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
    const content = Array.isArray(result.content) ? result.content : [];
    const text = renderMcpToolContent(content);
    if (result.isError) return `MCP error calling ${qualified}: ${text || '(empty error result)'}`;
    return text || '(empty result)';
  } catch (err) {
    return `MCP error calling ${qualified}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function renderMcpToolContent(content: Array<{ type?: string; text?: string }>): string {
  let out = '';
  let truncated = false;
  for (const block of content) {
    const piece = block.type === 'text' && typeof block.text === 'string'
      ? block.text
      : JSON.stringify(block);
    const prefix = out ? '\n' : '';
    const remaining = MAX_MCP_TOOL_RESULT_CHARS - out.length - prefix.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    out += prefix + piece.slice(0, remaining);
    if (piece.length > remaining) {
      truncated = true;
      break;
    }
  }
  return truncated ? `${out}\n[truncated MCP tool result at ${MAX_MCP_TOOL_RESULT_CHARS} chars]` : out;
}
