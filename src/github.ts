// ============================================
// Claude Swarm - GitHub Integration (via gh CLI)
// ============================================

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * 실패한 Workflow Run
 */
export type FailedRun = {
  id: number;
  name: string;
  branch: string;
  repo: string;
  createdAt: string;
  url: string;
};

/**
 * GitHub 알림
 */
export type GitHubNotification = {
  id: string;
  reason: string;
  title: string;
  repo: string;
  type: string;
  updatedAt: string;
  url?: string;
};

/**
 * 특정 레포의 실패한 workflow runs 조회
 */
export async function getFailedRuns(
  repo: string,
  limit: number = 5
): Promise<FailedRun[]> {
  try {
    const { stdout } = await execAsync(
      `gh run list -R ${repo} -s failure --json databaseId,name,headBranch,createdAt,url -L ${limit}`
    );

    const runs = JSON.parse(stdout);
    return runs.map((run: any) => ({
      id: run.databaseId,
      name: run.name,
      branch: run.headBranch,
      repo,
      createdAt: run.createdAt,
      url: run.url ?? `https://github.com/${repo}/actions/runs/${run.databaseId}`,
    }));
  } catch (err) {
    console.error(`Failed to get failed runs for ${repo}:`, err);
    return [];
  }
}

/**
 * 모든 등록된 레포의 실패한 runs 조회
 */
export async function getAllFailedRuns(
  repos: string[],
  limit: number = 3
): Promise<FailedRun[]> {
  const results = await Promise.all(
    repos.map((repo) => getFailedRuns(repo, limit))
  );
  return results.flat().sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * GitHub 알림 조회
 */
export async function getNotifications(
  limit: number = 10
): Promise<GitHubNotification[]> {
  try {
    const { stdout } = await execAsync(
      `gh api /notifications --jq '.[] | {id, reason, title: .subject.title, type: .subject.type, repo: .repository.full_name, updated: .updated_at, url: .subject.url}'`
    );

    const lines = stdout.trim().split('\n').filter(Boolean);
    return lines.slice(0, limit).map((line) => {
      const n = JSON.parse(line);
      return {
        id: n.id,
        reason: n.reason,
        title: n.title,
        repo: n.repo,
        type: n.type,
        updatedAt: n.updated,
        url: n.url,
      };
    });
  } catch (err) {
    console.error('Failed to get notifications:', err);
    return [];
  }
}

/**
 * CI 관련 알림만 필터링
 */
export async function getCINotifications(): Promise<GitHubNotification[]> {
  const notifications = await getNotifications(50);
  return notifications.filter(
    (n) => n.reason === 'ci_activity' || n.title.toLowerCase().includes('failed')
  );
}

/**
 * 특정 알림 읽음 처리
 */
export async function markNotificationRead(threadId: string): Promise<void> {
  try {
    await execAsync(`gh api -X PATCH /notifications/threads/${threadId}`);
  } catch (err) {
    console.error(`Failed to mark notification ${threadId} as read:`, err);
  }
}

/**
 * Workflow run 상세 정보 조회
 */
export async function getRunDetails(
  repo: string,
  runId: number
): Promise<{ jobs: { name: string; conclusion: string; steps: any[] }[] } | null> {
  try {
    const { stdout } = await execAsync(
      `gh run view ${runId} -R ${repo} --json jobs`
    );
    return JSON.parse(stdout);
  } catch (err) {
    console.error(`Failed to get run details for ${runId}:`, err);
    return null;
  }
}

/**
 * Workflow run 로그 조회 (실패한 job만)
 */
export async function getFailedJobLogs(
  repo: string,
  runId: number
): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `gh run view ${runId} -R ${repo} --log-failed 2>/dev/null | tail -100`
    );
    return stdout;
  } catch (err) {
    console.error(`Failed to get failed job logs for ${runId}:`, err);
    return '';
  }
}

/**
 * PR 체크 상태 조회
 */
export async function getPRChecks(
  repo: string,
  prNumber: number
): Promise<{ name: string; status: string; conclusion: string }[]> {
  try {
    const { stdout } = await execAsync(
      `gh pr checks ${prNumber} -R ${repo} --json name,state,conclusion`
    );
    return JSON.parse(stdout);
  } catch (err) {
    console.error(`Failed to get PR checks for ${repo}#${prNumber}:`, err);
    return [];
  }
}

/**
 * CI 실패 요약 생성
 */
export async function summarizeCIFailures(repos: string[]): Promise<string> {
  const failures = await getAllFailedRuns(repos, 3);

  if (failures.length === 0) {
    return '✅ 모든 CI 통과';
  }

  const summary = failures.map((f) => {
    const time = new Date(f.createdAt).toLocaleString('ko-KR');
    return `❌ **${f.repo}** - ${f.name}\n   브랜치: ${f.branch}\n   시간: ${time}`;
  });

  return `**CI 실패 ${failures.length}건:**\n\n${summary.join('\n\n')}`;
}

/**
 * GitHub 알림 요약 생성
 */
export async function summarizeNotifications(): Promise<string> {
  const notifications = await getNotifications(10);

  if (notifications.length === 0) {
    return '📭 새 알림 없음';
  }

  const byReason: Record<string, number> = {};
  for (const n of notifications) {
    byReason[n.reason] = (byReason[n.reason] || 0) + 1;
  }

  const breakdown = Object.entries(byReason)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(', ');

  const recent = notifications.slice(0, 3).map((n) => {
    const emoji = n.reason === 'ci_activity' ? '🔴' : '📬';
    return `${emoji} [${n.repo}] ${n.title}`;
  });

  return `**GitHub 알림 ${notifications.length}건** (${breakdown})\n\n${recent.join('\n')}`;
}
