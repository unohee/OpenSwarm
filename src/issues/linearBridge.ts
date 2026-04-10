// ============================================
// OpenSwarm - Linear ↔ Local Issue Bridge
// Created: 2026-04-03
// Purpose: Linear 이슈를 로컬 DB와 양방향 동기화 (optional)
// Dependencies: @linear/sdk, sqliteStore
// ============================================

import type { SqliteIssueStore } from './sqliteStore.js';
import type { Issue, IssueStatus, IssuePriority } from './schema.js';

// Linear SDK는 동적 import (Linear 미사용 시 로드 안 함)
let linearClient: any = null;
let linearTeamId: string = '';

/**
 * Linear 브릿지 초기화
 * config.yaml에서 linear.enabled: true 일 때만 호출
 */
export function initLinearBridge(apiKey: string, teamId: string): void {
  // 기존 linear.ts의 클라이언트를 재사용하기 위해 동적 import
  linearTeamId = teamId;
  import('@linear/sdk').then(({ LinearClient }) => {
    linearClient = new LinearClient({ apiKey });
    console.log('[LinearBridge] 초기화 완료 — team:', teamId);
  }).catch((err) => {
    console.warn('[LinearBridge] Linear SDK 로드 실패:', err);
  });
}

/**
 * Linear → 로컬: Linear 이슈를 로컬 DB에 동기화
 */
export async function syncFromLinear(
  store: SqliteIssueStore,
  projectId: string,
  options?: { states?: string[]; limit?: number },
): Promise<{ created: number; updated: number }> {
  if (!linearClient) {
    console.warn('[LinearBridge] 클라이언트 미초기화');
    return { created: 0, updated: 0 };
  }

  const states = options?.states ?? ['In Progress', 'Todo', 'Backlog'];
  const limit = options?.limit ?? 50;

  let created = 0;
  let updated = 0;

  try {
    const issues = await linearClient.issues({
      filter: {
        team: { id: { eq: linearTeamId } },
        state: { name: { in: states } },
      },
      first: limit,
      orderBy: 'updatedAt',
    });

    for (const issue of issues.nodes) {
      const existing = findByLinearId(store, issue.id);
      const linearData = await mapLinearToLocal(issue, projectId);

      if (existing) {
        // 이미 존재 → 업데이트
        store.updateIssue(existing.id, linearData);
        updated++;
      } else {
        // 새 이슈 → 생성
        store.createIssue({
          ...linearData,
          source: 'linear',
          linearId: issue.id,
          linearIdentifier: issue.identifier,
          linearUrl: issue.url,
        });
        created++;
      }
    }

    console.log(`[LinearBridge] 동기화 완료 — created: ${created}, updated: ${updated}`);
  } catch (err) {
    console.error('[LinearBridge] 동기화 실패:', err);
  }

  return { created, updated };
}

/**
 * 로컬 → Linear: 로컬 이슈를 Linear에 생성
 */
export async function pushToLinear(
  store: SqliteIssueStore,
  issueId: string,
): Promise<string | null> {
  if (!linearClient) {
    console.warn('[LinearBridge] 클라이언트 미초기화');
    return null;
  }

  const issue = store.getIssue(issueId);
  if (!issue) return null;
  if (issue.linearId) return issue.linearId; // 이미 연결됨

  try {
    const stateId = await resolveLinearStateId(mapStatusToLinear(issue.status));

    const created = await linearClient.createIssue({
      teamId: linearTeamId,
      title: issue.title,
      description: issue.description || undefined,
      priority: mapPriorityToLinear(issue.priority),
      stateId,
    });

    const linearIssue = await created.issue;
    if (!linearIssue) return null;

    // 로컬 이슈에 Linear ID 연결
    store.updateIssue(issueId, {
      linearId: linearIssue.id,
      linearIdentifier: linearIssue.identifier,
      linearUrl: linearIssue.url,
    });

    store.addEvent(issueId, 'linked', {
      content: `Linear에 생성: ${linearIssue.identifier}`,
      newValue: linearIssue.identifier,
    });

    console.log(`[LinearBridge] 이슈 ${issueId} → Linear ${linearIssue.identifier}`);
    return linearIssue.id;
  } catch (err) {
    console.error('[LinearBridge] Linear 생성 실패:', err);
    return null;
  }
}

/**
 * 상태 동기화: 로컬 상태 변경 → Linear 반영
 */
export async function syncStatusToLinear(
  store: SqliteIssueStore,
  issueId: string,
  newStatus: IssueStatus,
): Promise<boolean> {
  if (!linearClient) return false;

  const issue = store.getIssue(issueId);
  if (!issue?.linearId) return false;

  try {
    const stateId = await resolveLinearStateId(mapStatusToLinear(newStatus));
    await linearClient.updateIssue(issue.linearId, { stateId });
    console.log(`[LinearBridge] Linear 상태 업데이트: ${issue.linearIdentifier} → ${newStatus}`);
    return true;
  } catch (err) {
    console.error('[LinearBridge] 상태 동기화 실패:', err);
    return false;
  }
}

// ============ 매핑 유틸 ============

function findByLinearId(store: SqliteIssueStore, linearId: string): Issue | null {
  const { issues } = store.listIssues({ limit: 1, offset: 0 });
  // linear ID로 검색하려면 직접 쿼리가 필요
  // 간단히 전체 목록에서 찾기 (비효율적이지만 동기화는 드물게 실행)
  const { issues: all } = store.listIssues({ limit: 1000, offset: 0 });
  return all.find((i) => i.linearId === linearId) ?? null;
}

async function mapLinearToLocal(
  linearIssue: any,
  projectId: string,
): Promise<{
  projectId: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
}> {
  const state = await linearIssue.state;
  const stateName = state?.name ?? 'Backlog';

  return {
    projectId,
    title: linearIssue.title,
    description: linearIssue.description ?? '',
    status: mapLinearStatusToLocal(stateName),
    priority: mapLinearPriorityToLocal(linearIssue.priority),
  };
}

function mapLinearStatusToLocal(stateName: string): IssueStatus {
  const map: Record<string, IssueStatus> = {
    'Backlog': 'backlog',
    'Todo': 'todo',
    'In Progress': 'in_progress',
    'In Review': 'in_review',
    'Done': 'done',
    'Cancelled': 'cancelled',
    'Canceled': 'cancelled',
  };
  return map[stateName] ?? 'backlog';
}

function mapStatusToLinear(status: IssueStatus): string {
  const map: Record<IssueStatus, string> = {
    backlog: 'Backlog',
    todo: 'Todo',
    in_progress: 'In Progress',
    in_review: 'In Review',
    done: 'Done',
    cancelled: 'Cancelled',
  };
  return map[status];
}

function mapLinearPriorityToLocal(priority: number): IssuePriority {
  // Linear: 0=none, 1=urgent, 2=high, 3=medium, 4=low
  const map: Record<number, IssuePriority> = {
    0: 'none',
    1: 'urgent',
    2: 'high',
    3: 'medium',
    4: 'low',
  };
  return map[priority] ?? 'medium';
}

function mapPriorityToLinear(priority: IssuePriority): number {
  const map: Record<IssuePriority, number> = {
    urgent: 1,
    high: 2,
    medium: 3,
    low: 4,
    none: 0,
  };
  return map[priority];
}

async function resolveLinearStateId(stateName: string): Promise<string> {
  if (!linearClient) throw new Error('Linear 클라이언트 미초기화');

  const team = await linearClient.team(linearTeamId);
  const states = await team.states();
  const state = states.nodes.find((s: any) => s.name === stateName);
  if (!state) throw new Error(`Linear 상태 "${stateName}" 없음`);
  return state.id;
}

export function isLinearBridgeReady(): boolean {
  return linearClient !== null;
}
