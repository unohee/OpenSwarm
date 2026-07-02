// ============================================
// OpenSwarm - Monitor row mappers (EPIC INT-1813 S6 / INT-1939)
// Pure daemon-JSON → table mappers for the Projects/Tasks/Stuck/Issues tabs.
// No React/ink/network — unit-tested. DataTable renders the {columns, rows}.
// ============================================

export interface Table {
  columns: string[];
  rows: string[][];
}

export interface ApiProject {
  name: string;
  path: string;
  enabled: boolean;
  running?: string[];
  queued?: string[];
}

export function projectsToTable(projects: ApiProject[]): Table {
  return {
    columns: ['', 'PROJECT', 'RUN', 'QUEUE'],
    rows: projects.map((p) => [
      p.enabled ? '●' : '○',
      p.name,
      String(p.running?.length ?? 0),
      String(p.queued?.length ?? 0),
    ]),
  };
}

export interface ApiPipelineEvent {
  type: string;
  data: {
    taskId?: string;
    stage?: string;
    status?: string;
    model?: string;
    title?: string;
    issueIdentifier?: string;
  };
}

const STAGE_ICON: Record<string, string> = { start: '◐', complete: '●', fail: '✗' };

/** Most-recent pipeline stage events as task rows (newest first). */
export function pipelineToTable(stages: ApiPipelineEvent[], limit = 15): Table {
  const info = new Map<string, string>(); // taskId → identifier/title
  const events: Array<{ taskId: string; stage: string; status: string; model?: string }> = [];
  for (const ev of stages) {
    if (ev.type === 'task:started' && ev.data.taskId) {
      info.set(ev.data.taskId, ev.data.issueIdentifier || ev.data.title || ev.data.taskId);
    } else if (ev.type === 'pipeline:stage' && ev.data.taskId && ev.data.stage) {
      events.push({ taskId: ev.data.taskId, stage: ev.data.stage, status: ev.data.status ?? '', model: ev.data.model });
    }
  }
  const recent = events.slice(-limit).reverse();
  return {
    columns: ['TASK', 'STAGE', 'MODEL', 'STATUS'],
    rows: recent.map((e) => [
      (info.get(e.taskId) ?? e.taskId).slice(0, 14),
      e.stage,
      e.model ? e.model.split('-').slice(-2).join('-') : '',
      `${STAGE_ICON[e.status] ?? '○'} ${e.status}`,
    ]),
  };
}

export interface ApiStuckIssue {
  identifier: string;
  title: string;
  reason: string;
  priority: number | string;
  project?: { name: string };
}

const PRIO = (p: number | string) => {
  if (typeof p === 'string') {
    const normalized = p.toLowerCase();
    return normalized === 'medium' ? 'med' : normalized;
  }
  return p === 1 ? 'urgent' : p === 2 ? 'high' : p === 3 ? 'med' : 'low';
};

export function stuckToTable(stuck: ApiStuckIssue[], failed: ApiStuckIssue[]): Table {
  const row = (kind: string) => (i: ApiStuckIssue): string[] => [
    kind,
    i.identifier,
    i.title.length > 40 ? `${i.title.slice(0, 39)}…` : i.title,
    PRIO(i.priority),
    i.reason.length > 30 ? `${i.reason.slice(0, 29)}…` : i.reason,
  ];
  return {
    columns: ['KIND', 'ID', 'TITLE', 'PRIO', 'REASON'],
    rows: [...stuck.map(row('stuck')), ...failed.map(row('failed'))],
  };
}

export interface ApiIssue {
  id: string;
  title: string;
  status: string;
  priority: number | string;
}

export function issuesToTable(issues: ApiIssue[]): Table {
  return {
    columns: ['TITLE', 'STATUS', 'PRIO'],
    rows: issues.map((i) => [
      i.title.length > 50 ? `${i.title.slice(0, 49)}…` : i.title,
      i.status,
      PRIO(i.priority),
    ]),
  };
}
