// ============================================
// OpenSwarm - Monitor API client (EPIC INT-1813 S6 / INT-1939)
// Network boundary: fetches daemon snapshots for the monitor tabs. The pure
// mappers (monitorRows.ts) turn these into tables. Default daemon port 3847.
// ============================================

import { projectsToTable, pipelineToTable, stuckToTable, issuesToTable, type Table } from './monitorRows.js';

const base = (port: number) => `http://127.0.0.1:${port}`;

async function assertOk(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  let message = body.trim() || res.statusText || 'request failed';
  try {
    const json = JSON.parse(body) as { error?: unknown; errors?: Array<{ message?: unknown }> };
    if (typeof json.error === 'string') message = json.error;
    else if (typeof json.errors?.[0]?.message === 'string') message = json.errors[0].message;
  } catch {
    // keep the raw body text
  }
  throw new Error(`${label} failed: HTTP ${res.status}: ${message}`);
}

export async function fetchProjects(port: number): Promise<Table> {
  const res = await fetch(`${base(port)}/api/projects`);
  await assertOk(res, 'GET /api/projects');
  return projectsToTable(await res.json());
}

export async function fetchTasks(port: number): Promise<Table> {
  const res = await fetch(`${base(port)}/api/pipeline`);
  await assertOk(res, 'GET /api/pipeline');
  const { stages } = (await res.json()) as { stages: unknown[] };
  return pipelineToTable((stages ?? []) as never);
}

export async function fetchStuck(port: number): Promise<Table> {
  const res = await fetch(`${base(port)}/api/stuck-issues`);
  await assertOk(res, 'GET /api/stuck-issues');
  const { stuckIssues, failedIssues } = (await res.json()) as { stuckIssues: never[]; failedIssues: never[] };
  return stuckToTable(stuckIssues ?? [], failedIssues ?? []);
}

export async function fetchIssues(port: number): Promise<Table> {
  const res = await fetch(`${base(port)}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: '{ issues(filter: { limit: 50 }) { issues { id title status priority } total } }',
    }),
  });
  await assertOk(res, 'POST /graphql');
  const json = (await res.json()) as { data?: { issues?: { issues?: never[] } }; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return issuesToTable(json.data?.issues?.issues ?? []);
}
