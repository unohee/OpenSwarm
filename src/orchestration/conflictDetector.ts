// ============================================
// OpenSwarm - Worktree File Conflict Detector
// Knowledge Graph 기반 태스크 간 파일 충돌 감지
// Created: 2026-03-14
// Purpose: 병렬 워크트리 실행 시 동일 파일 수정 충돌 방지

import type { TaskItem } from './decisionEngine.js';
import { analyzeIssue } from '../knowledge/index.js';

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
 * Normalize a file/module identifier so two declarations of the same path
 * compare equal: lowercase, trim, strip a leading `./`. Empty/blank entries
 * are dropped.
 */
function normalizeScope(entries: string[] | undefined): Set<string> {
  const out = new Set<string>();
  if (!entries) return out;
  for (const raw of entries) {
    if (typeof raw !== 'string') continue;
    const normalized = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    if (isVolatileScopePath(normalized)) continue;
    if (normalized) out.add(normalized);
  }
  return out;
}

const UNKNOWN_SCOPE = 'unknown-file-scope';
const VOLATILE_SCOPE_SEGMENTS = new Set([
  'trash',
  'worktree',
  '.openswarm',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
]);
const VOLATILE_SCOPE_PREFIXES = ['worktree_'];

function isVolatileScopePath(path: string): boolean {
  if (!path || path === UNKNOWN_SCOPE) return true;
  const parts = path.split('/').filter(Boolean);
  return parts.some(part => VOLATILE_SCOPE_SEGMENTS.has(part) || VOLATILE_SCOPE_PREFIXES.some(prefix => part.startsWith(prefix)));
}

/**
 * Detect file-scope overlap between tasks. Each task's scope prefers the
 * planner-declared `fileScope` (authoritative), falling back to Knowledge Graph
 * inference (`analyzeIssue`) only when no explicit scope is available.
 * Overlapping tasks are grouped into a ConflictGroup; only the highest-priority
 * task in each group is returned as safe to run concurrently.
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
  const unknownScopeIndices = new Set<number>();

  await Promise.all(
    tasks.map(async (task, idx) => {
      // Prefer the planner-declared file scope. It is what the worker is
      // actually constrained to, so it is more accurate than KG inference and
      // needs no graph lookup.
      const declared = normalizeScope(task.fileScope);
      if (declared.size > 0) {
        taskImpacts.set(idx, declared);
        return;
      }

      // Fall back to Knowledge Graph inference when no explicit scope exists.
      try {
        const impact = await analyzeIssue(projectPath, task.title, task.description);
        if (impact) {
          const modules = normalizeScope([...impact.directModules, ...impact.dependentModules]);
          if (modules.size > 0) {
            taskImpacts.set(idx, modules);
            return;
          }
        }
      } catch (err) {
        console.warn(`[ConflictDetector] Impact analysis failed for ${task.id}:`, err);
      }
      unknownScopeIndices.add(idx);
    })
  );

  // Step 2: 태스크 쌍 비교로 교집합 계산 → Union-Find로 충돌 그룹 병합
  const uf = new UnionFind(tasks.length);
  // 쌍별 공유 모듈 기록
  const pairShared: Map<string, Set<string>> = new Map();

  for (let i = 0; i < tasks.length; i++) {
    const modulesI = taskImpacts.get(i);

    for (let j = i + 1; j < tasks.length; j++) {
      const modulesJ = taskImpacts.get(j);
      if (unknownScopeIndices.has(i) || unknownScopeIndices.has(j)) {
        // Unknown scope is a soft risk, not proof of a file conflict. Let the
        // PR processor handle any real merge conflicts later instead of
        // starving worker slots on uncertainty.
        continue;
      }

      if (!modulesI || modulesI.size === 0) continue;
      if (!modulesJ || modulesJ.size === 0) continue;

      // 교집합 계산
      const shared: string[] = [];
      for (const mod of modulesI) {
        if (modulesJ.has(mod)) {
          shared.push(mod);
        }
      }

      if (shared.length > 0) {
        const key = `${i}:${j}`;
        if (!pairShared.has(key)) {
          pairShared.set(key, new Set());
        }
        for (const mod of shared) {
          pairShared.get(key)!.add(mod);
        }
        uf.union(i, j);
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

  for (const [, indices] of groups) {
    if (indices.length === 1) {
      // 단일 태스크 → safe
      for (const idx of indices) {
        safe.push(tasks[idx]);
      }
      continue;
    }

    // 충돌 그룹: 최고 우선순위(낮은 숫자) 태스크만 safe에 포함
    const groupTasks = indices.map(i => tasks[i]);
    const sharedModuleSet = new Set<string>();
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const shared = pairShared.get(`${indices[a]}:${indices[b]}`);
        if (!shared) continue;
        for (const mod of shared) {
          sharedModuleSet.add(mod);
        }
      }
    }
    const sharedModules = Array.from(sharedModuleSet);

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
