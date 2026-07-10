// Coverage companion for scheduleCommand.ts — the base scheduleCommand.test.ts
// always injects an explicit `deps` object, so `defaultDeps()` (the dynamic
// `../automation/scheduler.js` import) is never exercised, nor is the
// five-field-cron arg-parsing branch or the `opts.path ?? process.cwd()`
// fallback. This file drives those paths with the scheduler module mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runScheduleCommand } from './scheduleCommand.js';
import type { ScheduledJob } from '../automation/scheduler.js';

const addScheduleMock = vi.fn();
const listSchedulesMock = vi.fn();
const removeScheduleMock = vi.fn();
const toggleScheduleMock = vi.fn();
vi.mock('../automation/scheduler.js', () => ({
  addSchedule: addScheduleMock,
  listSchedules: listSchedulesMock,
  removeSchedule: removeScheduleMock,
  toggleSchedule: toggleScheduleMock,
}));

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runScheduleCommand — defaultDeps() (no deps injected)', () => {
  it('add routes through the real scheduler module', async () => {
    addScheduleMock.mockResolvedValueOnce(job({ name: 'nightly', schedule: '0 3 * * *' }));
    const msg = await runScheduleCommand('add', ['nightly', '0 3 * * *', 'run', 'audit'], { path: '/proj' });
    expect(addScheduleMock).toHaveBeenCalledWith('nightly', '/proj', 'run audit', '0 3 * * *');
    expect(msg).toMatch(/Added schedule "nightly"/);
  });

  it('list routes through the real scheduler module', async () => {
    listSchedulesMock.mockResolvedValueOnce([job()]);
    const msg = await runScheduleCommand('list', []);
    expect(listSchedulesMock).toHaveBeenCalledOnce();
    expect(msg).toContain('nightly');
  });

  it('remove routes through the real scheduler module', async () => {
    removeScheduleMock.mockResolvedValueOnce(true);
    const msg = await runScheduleCommand('remove', ['nightly']);
    expect(removeScheduleMock).toHaveBeenCalledWith('nightly');
    expect(msg).toMatch(/Removed/);
  });

  it('pause/toggle routes through the real scheduler module', async () => {
    toggleScheduleMock.mockResolvedValueOnce(job({ enabled: false }));
    const msg = await runScheduleCommand('pause', ['nightly']);
    expect(toggleScheduleMock).toHaveBeenCalledWith('nightly');
    expect(msg).toMatch(/Paused/);
  });
});

describe('runScheduleCommand add — arg parsing edge cases (parseAddArgs)', () => {
  it('parses a five-field cron split across separate args', async () => {
    addScheduleMock.mockImplementationOnce(async (name: string, projectPath: string, prompt: string, schedule: string) =>
      job({ name, projectPath, prompt, schedule }),
    );
    const msg = await runScheduleCommand(
      'add',
      ['nightly', '0', '3', '*', '*', '*', 'run', 'the', 'audit'],
      { path: '/proj' },
    );
    expect(addScheduleMock).toHaveBeenCalledWith('nightly', '/proj', 'run the audit', '0 3 * * *');
    expect(msg).toMatch(/Added schedule "nightly" \(0 3 \* \* \*\)/);
  });

  it('treats a single no-space schedule token (e.g. an interval) as the schedule, not a cron', async () => {
    addScheduleMock.mockImplementationOnce(async (name: string, projectPath: string, prompt: string, schedule: string) =>
      job({ name, projectPath, prompt, schedule }),
    );
    const msg = await runScheduleCommand('add', ['every5m', '5m', 'run', 'audit'], { path: '/proj' });
    expect(addScheduleMock).toHaveBeenCalledWith('every5m', '/proj', 'run audit', '5m');
    expect(msg).toMatch(/Added schedule "every5m"/);
  });

  it('falls back to the single-token schedule when >=6 args do not actually look like a cron', async () => {
    addScheduleMock.mockImplementationOnce(async (name: string, projectPath: string, prompt: string, schedule: string) =>
      job({ name, projectPath, prompt, schedule }),
    );
    // 8 rest-args (>=6) but the first 5 are not a valid 5-field cron shape.
    const msg = await runScheduleCommand(
      'add',
      ['nightly', 'notacron', 'run', 'a', 'very', 'long', 'audit', 'task'],
      { path: '/proj' },
    );
    expect(addScheduleMock).toHaveBeenCalledWith(
      'nightly',
      '/proj',
      'run a very long audit task',
      'notacron',
    );
    expect(msg).toMatch(/Added schedule "nightly"/);
  });

  it('defaults the project path to process.cwd() when opts.path is not given', async () => {
    addScheduleMock.mockImplementationOnce(async (name: string, projectPath: string, prompt: string, schedule: string) =>
      job({ name, projectPath, prompt, schedule }),
    );
    await runScheduleCommand('add', ['nightly', '5m', 'run', 'audit'], {});
    expect(addScheduleMock).toHaveBeenCalledWith('nightly', process.cwd(), 'run audit', '5m');
  });
});

describe('runScheduleCommand — missing-name usage errors and "not found" replies', () => {
  it('remove requires a name', async () => {
    await expect(runScheduleCommand('remove', [])).rejects.toThrow(/usage: openswarm schedule remove/);
    expect(removeScheduleMock).not.toHaveBeenCalled();
  });

  it('pause requires a name', async () => {
    await expect(runScheduleCommand('pause', [])).rejects.toThrow(/usage: openswarm schedule pause/);
    expect(toggleScheduleMock).not.toHaveBeenCalled();
  });

  it('pause reports "No schedule named" when toggleSchedule finds nothing', async () => {
    toggleScheduleMock.mockResolvedValueOnce(null);
    const msg = await runScheduleCommand('pause', ['ghost']);
    expect(msg).toBe('No schedule named "ghost".');
  });
});

describe('formatScheduleList — lastRun timestamp rendering', () => {
  it('renders the "(last: ...)" suffix when lastRun is set', async () => {
    const { formatScheduleList } = await import('./scheduleCommand.js');
    const ts = Date.UTC(2026, 0, 1, 12, 0, 0);
    const out = formatScheduleList([job({ lastRun: ts })]);
    expect(out).toContain(`(last: ${new Date(ts).toISOString()})`);
  });
});
