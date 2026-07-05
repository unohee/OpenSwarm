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

describe('ClaudeCliAdapter.buildCommand model pinning (INT-2509)', () => {
  it('pins --model to the adapter default when the caller omits model', () => {
    // Omitting --model would run the user's PERSONAL default (can be the most
    // expensive tier) — the planner path hits this because it drops claude-* ids.
    const { command } = new ClaudeCliAdapter().buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
    });
    expect(command).toContain('--model sonnet');
  });

  it('keeps an explicit model', () => {
    const { command } = new ClaudeCliAdapter().buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'opus',
    });
    expect(command).toContain('--model opus');
    expect(command).not.toContain('--model sonnet');
  });
});
