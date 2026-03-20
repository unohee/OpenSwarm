// ============================================
// OpenSwarm - Worktree File Conflict Detector
// Knowledge Graph 기반 태스크 간 파일 충돌 감지
// Created: 2026-03-14
// Purpose: 병렬 워크트리 실행 시 동일 파일 수정 충돌 방지

import type { TaskItem } from './decisionEngine.js';
import { analyzeIssue } from '../knowledge/index.js';
import type { ImpactAnalysis } from '../knowledge/types.js';

// Types

export interface ConflictGroup {
  tasks: TaskItem[];
  sharedModules: string[];
}

export interface ConflictDetectionResult {
  safe: TaskItem[];
  conflictGroups: ConflictGroup[];
}

// Union-Find (Disjoint Set)

class UnionFind {
  private parent: Map<number, number> = new Map();
  private rank: Map<number, number> = new Map();

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      this.parent.set(i, i);
      this.rank.set(i, 0);
    }
  }

  find(x: number): number {
    if (this.parent.get(x) !== x) {
      this.parent.set(x, this.find(this.parent.get(x)!));
    }
    return this.parent.get(x)!;
  }

  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;

    const rankX = this.rank.get(rx)!;
    const rankY = this.rank.get(ry)!;
    if (rankX < rankY) {
      this.parent.set(rx, ry);
    } else if (rankX > rankY) {
      this.parent.set(ry, rx);
    } else {
      this.parent.set(ry, rx);
      this.rank.set(rx, rankX + 1);
    }
  }
}

// Conflict Detection

/**
 * Knowledge Graph를 사용하여 태스크 간 파일 영향 범위 겹침을 감지.
 * 겹치는 태스크를 ConflictGroup으로 묶고, 각 그룹에서 최고 우선순위만 safe로 반환.
 */
export async function detectFileConflicts(
  tasks: TaskItem[],
  projectPath: string,
): Promise<ConflictDetectionResult> {
  if (tasks.length <= 1) {
    return { safe: tasks, conflictGroups: [] };
  }

  // Step 1: 각 태스크의 영향 모듈 집합 수집
  const taskImpacts: Map<number, Set<string>> = new Map();
  const impactResults: Map<number, ImpactAnalysis | null> = new Map();

  await Promise.all(
    tasks.map(async (task, idx) => {
      const impact = await analyzeIssue(projectPath, task.title, task.description);
      impactResults.set(idx, impact);

      if (impact) {
        const modules = new Set([...impact.directModules, ...impact.dependentModules]);
        taskImpacts.set(idx, modules);
      }
    })
  );

  // Step 2: 태스크 쌍 비교로 교집합 계산 → Union-Find로 충돌 그룹 병합
  const uf = new UnionFind(tasks.length);
  // 쌍별 공유 모듈 기록
  const pairShared: Map<string, Set<string>> = new Map();

  for (let i = 0; i < tasks.length; i++) {
    const modulesI = taskImpacts.get(i);
    if (!modulesI || modulesI.size === 0) continue;

    for (let j = i + 1; j < tasks.length; j++) {
      const modulesJ = taskImpacts.get(j);
      if (!modulesJ || modulesJ.size === 0) continue;

      // 교집합 계산
      const shared: string[] = [];
      for (const mod of modulesI) {
        if (modulesJ.has(mod)) {
          shared.push(mod);
        }
      }

      if (shared.length > 0) {
        uf.union(i, j);
        const key = `${uf.find(i)}`;
        if (!pairShared.has(key)) {
          pairShared.set(key, new Set());
        }
        for (const mod of shared) {
          pairShared.get(key)!.add(mod);
        }
      }
    }
  }

  // Step 3: 그룹 구성
  const groups: Map<number, number[]> = new Map();
  for (let i = 0; i < tasks.length; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root)!.push(i);
  }

  // Step 4: safe / conflictGroups 분류
  const safe: TaskItem[] = [];
  const conflictGroups: ConflictGroup[] = [];

  for (const [root, indices] of groups) {
    // 영향 분석이 없는 태스크(그래프 미존재)는 단독 그룹으로 safe
    const hasImpact = indices.some(i => taskImpacts.has(i));

    if (indices.length === 1 || !hasImpact) {
      // 단일 태스크 또는 영향 분석 없음 → safe
      for (const idx of indices) {
        safe.push(tasks[idx]);
      }
      continue;
    }

    // 충돌 그룹: 최고 우선순위(낮은 숫자) 태스크만 safe에 포함
    const groupTasks = indices.map(i => tasks[i]);
    const sharedModules = Array.from(pairShared.get(`${root}`) || []);

    // 우선순위 기준 정렬 (1=Urgent > 4=Low)
    groupTasks.sort((a, b) => a.priority - b.priority);

    // 최고 우선순위 태스크만 safe
    safe.push(groupTasks[0]);

    // 나머지는 충돌 그룹으로 기록
    conflictGroups.push({
      tasks: groupTasks,
      sharedModules,
    });
  }

  return { safe, conflictGroups };
}
