// ============================================
// OpenSwarm - `openswarm schedule add|list|remove|pause` (INT-1957)
// ============================================
//
// CLI surface over the existing scheduler (src/automation/scheduler.ts): register
// agent tasks on a cron/interval, persisted to ~/.openswarm/schedules.json and
// run by the daemon (startAllSchedules). The formatter is pure; routing delegates
// to the scheduler via injectable deps (testable without fs/cron).

import type { ScheduledJob } from '../automation/scheduler.js';

/** Render the schedule list for the terminal. */
export function formatScheduleList(jobs: ScheduledJob[]): string {
  if (!jobs.length) {
    return 'No schedules. Add one: openswarm schedule add <name> <cron|interval> <task>';
  }
  return jobs
    .map((j) => {
      const state = j.enabled ? '▶' : '⏸';
      const last = j.lastRun ? ` (last: ${new Date(j.lastRun).toISOString()})` : '';
      const fails = j.consecutiveFailures
        ? ` ⚠ ${j.consecutiveFailures} consecutive failure(s)${j.enabled ? '' : ' — auto-paused'}`
        : '';
      return `  ${state} ${j.name} — ${j.schedule} — ${j.prompt}${last}${fails}`;
    })
    .join('\n');
}

export interface ScheduleDeps {
  add: (name: string, projectPath: string, prompt: string, schedule: string) => Promise<ScheduledJob>;
  list: () => Promise<ScheduledJob[]>;
  remove: (nameOrId: string) => Promise<boolean>;
  toggle: (nameOrId: string) => Promise<ScheduledJob | null>;
}

async function defaultDeps(): Promise<ScheduleDeps> {
  const s = await import('../automation/scheduler.js');
  return {
    add: (name, projectPath, prompt, schedule) => s.addSchedule(name, projectPath, prompt, schedule),
    list: () => s.listSchedules(),
    remove: (nameOrId) => s.removeSchedule(nameOrId),
    toggle: (nameOrId) => s.toggleSchedule(nameOrId),
  };
}

export interface ScheduleCommandOptions {
  path?: string;
}

const CRON_NUMBER_FIELD = /^(?:\*|\d{1,2})(?:[-,/](?:\*|\d{1,2}))*$/;
const CRON_FIELD = /^(?:\*|\?|\d{1,2}|[a-z]{3})(?:[-,/#](?:\*|\?|\d{1,2}|[a-z]{3}))*$/i;

function looksLikeFiveFieldCron(parts: string[]): boolean {
  return parts.length === 5 && CRON_NUMBER_FIELD.test(parts[0]) && CRON_NUMBER_FIELD.test(parts[1]) && parts.slice(2).every((p) => CRON_FIELD.test(p));
}

function parseAddArgs(args: string[]): { name: string; schedule: string; prompt: string } {
  const [name, ...rest] = args;
  if (!name || rest.length < 2) {
    throw new Error('usage: openswarm schedule add <name> <cron|interval> <task...>');
  }

  if (rest[0].includes(' ')) {
    return { name, schedule: rest[0], prompt: rest.slice(1).join(' ') };
  }

  if (rest.length >= 6 && looksLikeFiveFieldCron(rest.slice(0, 5))) {
    return { name, schedule: rest.slice(0, 5).join(' '), prompt: rest.slice(5).join(' ') };
  }

  return { name, schedule: rest[0], prompt: rest.slice(1).join(' ') };
}

/** Route a `schedule` subcommand. Returns the message to print. */
export async function runScheduleCommand(
  action: string,
  args: string[],
  opts: ScheduleCommandOptions = {},
  deps?: ScheduleDeps,
): Promise<string> {
  const d = deps ?? (await defaultDeps());

  switch (action) {
    case 'add': {
      const { name, schedule, prompt } = parseAddArgs(args);
      const job = await d.add(name, opts.path ?? process.cwd(), prompt, schedule);
      return `Added schedule "${job.name}" (${job.schedule}). The daemon runs it on schedule.`;
    }

    case 'list':
      return formatScheduleList(await d.list());

    case 'remove': {
      const name = args[0];
      if (!name) throw new Error('usage: openswarm schedule remove <name>');
      return (await d.remove(name)) ? `Removed schedule "${name}".` : `No schedule named "${name}".`;
    }

    case 'pause':
    case 'toggle': {
      const name = args[0];
      if (!name) throw new Error('usage: openswarm schedule pause <name>');
      const job = await d.toggle(name);
      if (!job) return `No schedule named "${name}".`;
      return `${job.enabled ? 'Resumed' : 'Paused'} schedule "${name}".`;
    }

    default:
      throw new Error(`Unknown schedule action "${action}" (use add|list|remove|pause)`);
  }
}
