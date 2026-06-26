import { describe, it, expect, vi } from 'vitest';
import { formatScheduleList, runScheduleCommand, type ScheduleDeps } from './scheduleCommand.js';
import type { ScheduledJob } from '../automation/scheduler.js';

const job = (over: Partial<ScheduledJob> = {}): ScheduledJob => ({
  id: 'job-1',
  name: 'nightly',
  projectPath: '/p',
  prompt: 'run audit',
  schedule: '0 3 * * *',
  enabled: true,
  createdAt: 0,
  ...over,
});

const mkDeps = (over: Partial<ScheduleDeps> = {}): ScheduleDeps => ({
  add: vi.fn(async (name, projectPath, prompt, schedule) => job({ name, projectPath, prompt, schedule })),
  list: vi.fn(async () => [job()]),
  remove: vi.fn(async () => true),
  toggle: vi.fn(async () => job({ enabled: false })),
  ...over,
});

describe('formatScheduleList (INT-1957)', () => {
  it('renders state, schedule, prompt', () => {
    const out = formatScheduleList([job(), job({ name: 'paused', enabled: false })]);
    expect(out).toContain('▶ nightly — 0 3 * * * — run audit');
    expect(out).toContain('⏸ paused');
  });
  it('helps when empty', () => {
    expect(formatScheduleList([])).toMatch(/No schedules/);
  });
});

describe('runScheduleCommand (INT-1957)', () => {
  it('add requires name + schedule + task', async () => {
    await expect(runScheduleCommand('add', ['only-name'], {}, mkDeps())).rejects.toThrow(/usage/);
  });

  it('add registers via the scheduler', async () => {
    const deps = mkDeps();
    const msg = await runScheduleCommand('add', ['nightly', '0 3 * * *', 'run', 'audit'], { path: '/proj' }, deps);
    expect(deps.add).toHaveBeenCalledWith('nightly', '/proj', 'run audit', '0 3 * * *');
    expect(msg).toMatch(/Added schedule "nightly"/);
  });

  it('list formats the scheduler output', async () => {
    expect(await runScheduleCommand('list', [], {}, mkDeps())).toContain('nightly');
  });

  it('remove reports found / not-found', async () => {
    expect(await runScheduleCommand('remove', ['nightly'], {}, mkDeps())).toMatch(/Removed/);
    expect(await runScheduleCommand('remove', ['ghost'], {}, mkDeps({ remove: async () => false }))).toMatch(/No schedule/);
  });

  it('pause toggles and reports the new state', async () => {
    expect(await runScheduleCommand('pause', ['nightly'], {}, mkDeps())).toMatch(/Paused/);
    expect(
      await runScheduleCommand('pause', ['nightly'], {}, mkDeps({ toggle: async () => job({ enabled: true }) })),
    ).toMatch(/Resumed/);
  });

  it('rejects unknown actions', async () => {
    await expect(runScheduleCommand('frob', [], {}, mkDeps())).rejects.toThrow(/Unknown schedule action/);
  });
});
