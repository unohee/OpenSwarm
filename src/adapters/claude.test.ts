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

  it('omits the memory MCP config when memoryTools=false', () => {
    const { command } = new ClaudeCliAdapter().buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'claude-sonnet-4',
      memoryTools: false,
    });

    expect(command).toContain('claude -p');
    expect(command).toContain('--permission-mode bypassPermissions');
    expect(command).not.toContain('--mcp-config');
  });
});
