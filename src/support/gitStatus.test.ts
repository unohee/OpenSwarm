import { afterEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn((_command, _args, _options, callback) => callback(new Error('not a repo'), '')));
vi.mock('node:child_process', () => ({ execFile }));

import { clearGitStatusCache, getGitStatusCacheSizeForTests, getProjectGitInfo } from './gitStatus.js';

afterEach(() => {
  clearGitStatusCache();
  vi.clearAllMocks();
});

describe('git status cache', () => {
  it('stays bounded under high-cardinality project paths', async () => {
    for (let index = 0; index < 250; index++) {
      await getProjectGitInfo(`/repo/${index}`);
    }
    expect(getGitStatusCacheSizeForTests()).toBe(200);
  });
});
