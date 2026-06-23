import { describe, it, expect } from 'vitest';
import { ClaudeCliAdapter } from './claude.js';

describe('ClaudeCliAdapter.buildCommand', () => {
  it('wires the memory MCP server via --mcp-config and keeps bypass permissions', () => {
    const { command } = new ClaudeCliAdapter().buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'claude-sonnet-4',
    });
    expect(command).toContain('claude -p');
    expect(command).toContain('--permission-mode bypassPermissions');
    expect(command).toContain('--mcp-config');
    expect(command).toMatch(/--mcp-config \S+mcp\.json/);
  });
});
