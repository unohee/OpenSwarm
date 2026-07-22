import { describe, it, expect } from 'vitest';
import { ClaudeCliAdapter } from './claude.js';

describe('ClaudeCliAdapter.buildCommand', () => {
  it('wires the memory MCP server via --mcp-config and keeps bypass permissions', () => {
    const { command, args, stdinFile } = new ClaudeCliAdapter().buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'claude-sonnet-4',
    });
    expect(command).toBe('claude');
    expect(args).toContain('-p');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toMatch(/mcp\.json$/);
    expect(stdinFile).toBe('/tmp/prompt.txt');
  });

  it('omits the memory MCP config when memoryTools=false', () => {
    const { command, args } = new ClaudeCliAdapter().buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'claude-sonnet-4',
      memoryTools: false,
    });

    expect(command).toBe('claude');
    expect(args).toContain('bypassPermissions');
    expect(args).not.toContain('--mcp-config');
  });
});

describe('ClaudeCliAdapter.buildCommand model pinning (INT-2509)', () => {
  it('pins --model to the adapter default when the caller omits model', () => {
    // Omitting --model would run the user's PERSONAL default (can be the most
    // expensive tier) — the planner path hits this because it drops claude-* ids.
    const { args } = new ClaudeCliAdapter().buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
    });
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'sonnet']);
  });

  it('keeps an explicit model', () => {
    const { args } = new ClaudeCliAdapter().buildCommand({
      prompt: '/tmp/prompt.txt',
      cwd: '/tmp/project',
      model: 'opus',
    });
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
    expect(args).not.toContain('sonnet');
  });

  it('keeps model metacharacters inside one argv element', () => {
    const { args } = new ClaudeCliAdapter().buildCommand({ prompt: '/tmp/prompt.txt', cwd: '/tmp', model: 'sonnet; touch /tmp/pwned' });
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet; touch /tmp/pwned');
  });
});
