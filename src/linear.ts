// ============================================
// Claude Swarm - Linear Integration
// ============================================

import { LinearClient } from '@linear/sdk';
import type { LinearIssueInfo, LinearComment } from './types.js';

let client: LinearClient | null = null;
let teamId: string = '';

/**
 * Linear 클라이언트 초기화
 */
export function initLinear(apiKey: string, team: string): void {
  client = new LinearClient({ apiKey });
  teamId = team;
}

/**
 * Linear 클라이언트 반환
 */
function getClient(): LinearClient {
  if (!client) {
    throw new Error('Linear client not initialized. Call initLinear() first.');
  }
  return client;
}

/**
 * 에이전트의 In Progress 이슈 조회
 */
export async function getInProgressIssues(
  agentLabel: string
): Promise<LinearIssueInfo[]> {
  const linear = getClient();

  const issues = await linear.issues({
    filter: {
      team: { id: { eq: teamId } },
      state: { name: { in: ['In Progress', 'Started'] } },
      labels: { name: { eq: agentLabel } },
    },
  });

  const result: LinearIssueInfo[] = [];

  for (const issue of issues.nodes) {
    const comments = await issue.comments();
    const labels = await issue.labels();

    result.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      state: (await issue.state)?.name ?? 'Unknown',
      priority: issue.priority,
      labels: labels.nodes.map((l) => l.name),
      comments: comments.nodes.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        user: undefined, // TODO: resolve user name
      })),
    });
  }

  return result;
}

/**
 * Backlog에서 다음 이슈 가져오기
 */
export async function getNextBacklogIssue(
  agentLabel: string
): Promise<LinearIssueInfo | null> {
  const linear = getClient();

  const issues = await linear.issues({
    filter: {
      team: { id: { eq: teamId } },
      state: { name: { in: ['Backlog', 'Todo'] } },
      labels: { name: { eq: agentLabel } },
    },
    first: 10, // 여러 개 가져와서 priority로 정렬
  });

  // priority 기준 정렬 (낮을수록 높은 우선순위: 1=Urgent, 4=Low, 0=None)
  const sorted = [...issues.nodes].sort((a, b) => {
    // priority 0(None)은 맨 뒤로
    const pa = a.priority === 0 ? 999 : a.priority;
    const pb = b.priority === 0 ? 999 : b.priority;
    return pa - pb;
  });

  const issue = sorted[0];
  if (!issue) return null;

  const comments = await issue.comments();
  const labels = await issue.labels();

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? undefined,
    state: (await issue.state)?.name ?? 'Unknown',
    priority: issue.priority,
    labels: labels.nodes.map((l) => l.name),
    comments: comments.nodes.map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
      user: undefined,
    })),
  };
}

/**
 * 이슈 상태 변경
 */
export async function updateIssueState(
  issueId: string,
  stateName: 'In Progress' | 'Done' | 'Blocked' | 'Backlog'
): Promise<void> {
  const linear = getClient();

  // 팀의 workflow states 조회
  const team = await linear.team(teamId);
  const states = await team.states();
  const targetState = states.nodes.find((s) =>
    s.name.toLowerCase().includes(stateName.toLowerCase())
  );

  if (!targetState) {
    console.error(`State "${stateName}" not found in team workflow`);
    return;
  }

  await linear.updateIssue(issueId, {
    stateId: targetState.id,
  });
}

/**
 * 이슈에 코멘트 추가
 */
export async function addComment(
  issueId: string,
  body: string
): Promise<void> {
  const linear = getClient();

  await linear.createComment({
    issueId,
    body,
  });
}

/**
 * 에이전트 작업 시작 코멘트
 */
export async function logWorkStart(
  issueId: string,
  sessionName: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  const body = `🤖 **[${sessionName}] 작업 시작**

시간: ${timestamp}

---
_자동 생성됨_`;

  await addComment(issueId, body);
  await updateIssueState(issueId, 'In Progress');
}

/**
 * 에이전트 진행상황 코멘트
 */
export async function logProgress(
  issueId: string,
  sessionName: string,
  progress: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  const body = `🤖 **[${sessionName}] 진행 상황**

${progress}

시간: ${timestamp}`;

  await addComment(issueId, body);
}

/**
 * 에이전트 작업 완료 코멘트
 */
export async function logWorkComplete(
  issueId: string,
  sessionName: string,
  summary?: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  const body = `🤖 **[${sessionName}] ✅ 작업 완료**

${summary ?? ''}

시간: ${timestamp}`;

  await addComment(issueId, body);
  await updateIssueState(issueId, 'Done');
}

/**
 * 에이전트 막힘 코멘트
 */
export async function logBlocked(
  issueId: string,
  sessionName: string,
  reason: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  const body = `🤖 **[${sessionName}] ⚠️ 막힘**

이유: ${reason}

사용자 개입 필요

시간: ${timestamp}`;

  await addComment(issueId, body);
  await updateIssueState(issueId, 'Blocked');
}

/**
 * 새 이슈 생성
 */
export async function createIssue(
  title: string,
  description: string,
  labels: string[] = []
): Promise<LinearIssueInfo> {
  const linear = getClient();

  // 라벨 ID 조회
  const team = await linear.team(teamId);
  const teamLabels = await team.labels();
  const labelIds = labels
    .map((name) => teamLabels.nodes.find((l) => l.name === name)?.id)
    .filter((id): id is string => !!id);

  const issuePayload = await linear.createIssue({
    teamId,
    title,
    description,
    labelIds,
  });

  const issue = await issuePayload.issue;
  if (!issue) {
    throw new Error('Failed to create issue');
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? undefined,
    state: 'Backlog',
    priority: issue.priority,
    labels,
    comments: [],
  };
}
