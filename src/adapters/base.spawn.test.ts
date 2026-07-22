import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from './types.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { spawnCli } from './base.js';

describe('argv-safe adapter spawning', () => {
  it('passes metacharacters as one argv value with shell disabled', async () => {
    const proc = Object.assign(new EventEmitter(), {
      pid: 123,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: { end: vi.fn() },
      kill: vi.fn(),
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => proc.emit('close', 0));
      return proc;
    });
    const injected = 'model; touch /tmp/openswarm-should-not-exist';
    const adapter: CliAdapter = {
      name: 'fixture',
      capabilities: {
        supportsStreaming: false,
        supportsJsonOutput: false,
        supportsModelSelection: true,
        managedGit: false,
        supportedSkills: [],
      },
      isAvailable: async () => true,
      getDefaultModel: async () => 'fixture',
      buildCommand: () => ({ command: 'fixture-cli', args: ['--model', injected] }),
      parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
      parseReviewerOutput: () => ({ decision: 'approve', feedback: '', issues: [], suggestions: [] }),
    };

    await expect(spawnCli(adapter, { prompt: 'hello', cwd: process.cwd() })).resolves.toMatchObject({ exitCode: 0 });
    expect(spawnMock).toHaveBeenCalledWith(
      'fixture-cli',
      ['--model', injected],
      expect.objectContaining({ shell: false }),
    );
  });
});
