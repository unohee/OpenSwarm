import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  memoryServerPath,
  memoryServerLaunch,
  writeClaudeMcpConfig,
  codexMcpConfigFlags,
  MEMORY_MCP_NAME,
} from './memoryMcp.js';

describe('memoryMcp', () => {
  it('memoryServerPath points at the built memory server entry', () => {
    expect(memoryServerPath().replace(/\\/g, '/')).toMatch(/\/mcp\/memoryServer\.js$/);
  });

  it('memoryServerLaunch runs the entry with the current node binary', () => {
    const { command, args } = memoryServerLaunch();
    expect(command).toBe(process.execPath);
    expect(args[0]).toMatch(/memoryServer\.js$/);
  });

  it('writeClaudeMcpConfig writes a valid mcp.json registering the memory server', () => {
    const file = writeClaudeMcpConfig();
    const cfg = JSON.parse(readFileSync(file, 'utf-8'));
    expect(cfg.mcpServers[MEMORY_MCP_NAME].command).toBe(process.execPath);
    expect(cfg.mcpServers[MEMORY_MCP_NAME].args[0]).toMatch(/memoryServer\.js$/);
  });

  it('codexMcpConfigFlags emits -c overrides for command and args', () => {
    const flags = codexMcpConfigFlags();
    expect(flags).toContain(`-c 'mcp_servers.${MEMORY_MCP_NAME}.command=`);
    expect(flags).toContain(`-c 'mcp_servers.${MEMORY_MCP_NAME}.args=[`);
  });
});
