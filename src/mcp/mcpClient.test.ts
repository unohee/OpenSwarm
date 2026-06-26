import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, isMcpTool, registryFromConfigServers, loadEffectiveRegistry } from './mcpClient.js';

let dir: string | null = null;
function writeMcpJson(content: unknown): string {
  dir = mkdtempSync(join(tmpdir(), 'mcp-reg-'));
  const p = join(dir, 'mcp.json');
  writeFileSync(p, JSON.stringify(content));
  return p;
}
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('isMcpTool', () => {
  it('treats `server__tool` names as MCP, native tools as not', () => {
    expect(isMcpTool('linear__list_issues')).toBe(true);
    expect(isMcpTool('fs__read_file')).toBe(true);
    expect(isMcpTool('read_file')).toBe(false);
    expect(isMcpTool('bash')).toBe(false);
  });
});

describe('loadRegistry', () => {
  it('normalizes a stdio entry (command/args/env)', () => {
    const p = writeMcpJson({ mcpServers: { fs: { command: 'npx', args: ['-y', 'server-filesystem', '/tmp'], env: { A: '1' } } } });
    const reg = loadRegistry(p);
    expect(reg.fs).toEqual({ transport: 'stdio', command: 'npx', args: ['-y', 'server-filesystem', '/tmp'], env: { A: '1' } });
  });

  it('normalizes a remote entry (url → http; sse honored)', () => {
    const p = writeMcpJson({
      mcpServers: {
        linear: { url: 'https://mcp.linear.app/mcp' },
        legacy: { url: 'https://x.example/sse', transport: 'sse', headers: { Authorization: 'Bearer t' } },
      },
    });
    const reg = loadRegistry(p);
    expect(reg.linear).toEqual({ transport: 'http', url: 'https://mcp.linear.app/mcp', headers: undefined });
    expect(reg.legacy).toEqual({ transport: 'sse', url: 'https://x.example/sse', headers: { Authorization: 'Bearer t' } });
  });

  it('drops malformed entries and returns {} for a missing file', () => {
    const p = writeMcpJson({ mcpServers: { bad: { nonsense: true } } });
    expect(loadRegistry(p)).toEqual({});
    expect(loadRegistry(join(tmpdir(), 'does-not-exist-xyz.json'))).toEqual({});
  });
});

describe('registryFromConfigServers (INT-1949)', () => {
  it('normalizes config.mcp.servers (stdio + remote) and drops invalid', () => {
    const reg = registryFromConfigServers({
      linear: { command: 'npx', args: ['-y', 'x'] },
      docs: { url: 'https://example.com/mcp' },
      stream: { url: 'https://example.com/sse', transport: 'sse' },
      broken: { args: ['x'] },
    });
    expect(reg.linear).toMatchObject({ transport: 'stdio', command: 'npx', args: ['-y', 'x'] });
    expect(reg.docs).toMatchObject({ transport: 'http', url: 'https://example.com/mcp' });
    expect(reg.stream).toMatchObject({ transport: 'sse' });
    expect(reg.broken).toBeUndefined();
  });

  it('handles undefined input', () => {
    expect(registryFromConfigServers(undefined)).toEqual({});
  });
});

describe('loadEffectiveRegistry (INT-1949)', () => {
  it('merges mcp.json with config servers, config winning on collision', () => {
    const p = writeMcpJson({ mcpServers: { fromFile: { command: 'file-cmd' }, shared: { command: 'file-shared' } } });
    const reg = loadEffectiveRegistry(
      { fromConfig: { url: 'https://c/mcp' }, shared: { command: 'config-shared' } },
      p,
    );
    expect(reg.fromFile).toMatchObject({ command: 'file-cmd' });
    expect(reg.fromConfig).toMatchObject({ url: 'https://c/mcp' });
    expect(reg.shared).toMatchObject({ command: 'config-shared' });
  });

  it('returns only config servers when the mcp.json path is absent', () => {
    expect(Object.keys(loadEffectiveRegistry({ only: { command: 'c' } }, join(tmpdir(), 'no-such-mcp.json')))).toEqual(['only']);
  });
});
