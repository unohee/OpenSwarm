// ============================================
// Claude Swarm - DAG Workflow Engine
// 에이전트 작업 의존성 관리 및 실행
// ============================================

import { resolve } from 'path';
import { homedir } from 'os';
import * as fs from 'fs/promises';
import * as yaml from 'yaml';

// ============================================
// Types & Interfaces
// ============================================

/**
 * 실패 시 처리 전략
 */
export type FailureStrategy = 'rollback' | 'retry' | 'skip' | 'abort' | 'notify';

/**
 * Step 실행 상태
 */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * 워크플로우 Step 정의
 */
export interface WorkflowStep {
  /** Step 고유 ID */
  id: string;

  /** Step 이름 (표시용) */
  name: string;

  /** 실행할 프롬프트 또는 명령 */
  prompt: string;

  /** 의존하는 Step ID 목록 */
  dependsOn?: string[];

  /** 실패 시 전략 (기본: abort) */
  onFailure?: FailureStrategy;

  /** 재시도 횟수 (retry 전략 시) */
  retryCount?: number;

  /** 타임아웃 (초) */
  timeout?: number;

  /** 조건부 실행 (이전 step 결과 기반) */
  condition?: string;

  /** Step별 환경 변수 */
  env?: Record<string, string>;
}

/**
 * 워크플로우 정의
 */
export interface WorkflowConfig {
  /** 워크플로우 고유 ID */
  id: string;

  /** 워크플로우 이름 */
  name: string;

  /** 설명 */
  description?: string;

  /** 대상 프로젝트 경로 */
  projectPath: string;

  /** Step 목록 */
  steps: WorkflowStep[];

  /** 전역 실패 전략 */
  onFailure?: FailureStrategy;

  /** 트리거 조건 */
  trigger?: {
    /** cron 표현식 */
    schedule?: string;
    /** Linear 이슈 상태 변경 시 */
    onIssueStatus?: string[];
    /** 수동 실행만 */
    manual?: boolean;
  };

  /** Linear 이슈 연동 */
  linearIssue?: string;
}

/**
 * Step 실행 결과
 */
export interface StepResult {
  stepId: string;
  status: StepStatus;
  startedAt: number;
  completedAt?: number;
  output?: string;
  error?: string;
  changedFiles?: string[];
}

/**
 * 워크플로우 실행 상태
 */
export interface WorkflowExecution {
  workflowId: string;
  executionId: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  startedAt: number;
  completedAt?: number;
  stepResults: Record<string, StepResult>;
  checkpoint?: string;  // git commit hash for rollback
}

// ============================================
// DAG Utilities
// ============================================

/**
 * Topological Sort (Kahn's Algorithm)
 * 의존성 순서대로 Step 정렬
 */
export function topologicalSort(steps: WorkflowStep[]): WorkflowStep[] {
  const graph = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  const stepMap = new Map<string, WorkflowStep>();

  // 그래프 초기화
  for (const step of steps) {
    stepMap.set(step.id, step);
    graph.set(step.id, new Set());
    inDegree.set(step.id, 0);
  }

  // 간선 추가 (의존성)
  for (const step of steps) {
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        if (!graph.has(dep)) {
          throw new Error(`Step "${step.id}" depends on unknown step "${dep}"`);
        }
        graph.get(dep)!.add(step.id);
        inDegree.set(step.id, (inDegree.get(step.id) || 0) + 1);
      }
    }
  }

  // Kahn's Algorithm
  const queue: string[] = [];
  const result: WorkflowStep[] = [];

  // 진입 차수 0인 노드 큐에 추가
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(stepMap.get(current)!);

    for (const neighbor of graph.get(current)!) {
      inDegree.set(neighbor, inDegree.get(neighbor)! - 1);
      if (inDegree.get(neighbor) === 0) {
        queue.push(neighbor);
      }
    }
  }

  // 순환 감지
  if (result.length !== steps.length) {
    throw new Error('Workflow contains circular dependencies');
  }

  return result;
}

/**
 * 현재 실행 가능한 Step 찾기 (의존성 모두 완료된 것)
 */
export function getExecutableSteps(
  steps: WorkflowStep[],
  results: Record<string, StepResult>
): WorkflowStep[] {
  return steps.filter(step => {
    // 이미 실행됨
    if (results[step.id]) return false;

    // 의존성 확인
    if (step.dependsOn) {
      for (const depId of step.dependsOn) {
        const depResult = results[depId];
        if (!depResult || depResult.status !== 'completed') {
          return false;
        }
      }
    }

    return true;
  });
}

/**
 * 병렬 실행 가능한 Step 그룹 찾기
 */
export function getParallelGroups(steps: WorkflowStep[]): WorkflowStep[][] {
  const sorted = topologicalSort(steps);
  const groups: WorkflowStep[][] = [];
  const completed = new Set<string>();

  while (completed.size < sorted.length) {
    const group: WorkflowStep[] = [];

    for (const step of sorted) {
      if (completed.has(step.id)) continue;

      // 의존성 모두 완료됨?
      const depsCompleted = !step.dependsOn ||
        step.dependsOn.every(dep => completed.has(dep));

      if (depsCompleted) {
        group.push(step);
      }
    }

    if (group.length === 0) break;

    groups.push(group);
    group.forEach(s => completed.add(s.id));
  }

  return groups;
}

// ============================================
// Workflow Storage
// ============================================

const WORKFLOW_DIR = resolve(homedir(), '.claude-swarm/workflows');
const EXECUTION_DIR = resolve(homedir(), '.claude-swarm/executions');

/**
 * 워크플로우 저장
 */
export async function saveWorkflow(workflow: WorkflowConfig): Promise<void> {
  await fs.mkdir(WORKFLOW_DIR, { recursive: true });
  const filePath = resolve(WORKFLOW_DIR, `${workflow.id}.yaml`);
  await fs.writeFile(filePath, yaml.stringify(workflow), 'utf-8');
  console.log(`[Workflow] Saved: ${workflow.name} (${workflow.id})`);
}

/**
 * 워크플로우 로드
 */
export async function loadWorkflow(workflowId: string): Promise<WorkflowConfig | null> {
  try {
    const filePath = resolve(WORKFLOW_DIR, `${workflowId}.yaml`);
    const content = await fs.readFile(filePath, 'utf-8');
    return yaml.parse(content) as WorkflowConfig;
  } catch {
    return null;
  }
}

/**
 * 모든 워크플로우 목록
 */
export async function listWorkflows(): Promise<WorkflowConfig[]> {
  try {
    await fs.mkdir(WORKFLOW_DIR, { recursive: true });
    const files = await fs.readdir(WORKFLOW_DIR);
    const workflows: WorkflowConfig[] = [];

    for (const file of files) {
      if (file.endsWith('.yaml')) {
        const content = await fs.readFile(resolve(WORKFLOW_DIR, file), 'utf-8');
        workflows.push(yaml.parse(content));
      }
    }

    return workflows;
  } catch {
    return [];
  }
}

/**
 * 실행 상태 저장
 */
export async function saveExecution(execution: WorkflowExecution): Promise<void> {
  await fs.mkdir(EXECUTION_DIR, { recursive: true });
  const filePath = resolve(EXECUTION_DIR, `${execution.executionId}.json`);
  await fs.writeFile(filePath, JSON.stringify(execution, null, 2), 'utf-8');
}

/**
 * 실행 상태 로드
 */
export async function loadExecution(executionId: string): Promise<WorkflowExecution | null> {
  try {
    const filePath = resolve(EXECUTION_DIR, `${executionId}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ============================================
// Workflow Templates
// ============================================

/**
 * CI 파이프라인 템플릿
 */
export function createCIPipelineTemplate(projectPath: string): WorkflowConfig {
  return {
    id: `ci-pipeline-${Date.now()}`,
    name: 'CI Pipeline',
    description: 'Lint → Test → Build → PR',
    projectPath,
    onFailure: 'rollback',
    steps: [
      {
        id: 'lint',
        name: 'Lint & Format',
        prompt: 'Run linting and fix any issues. Report what was fixed.',
        onFailure: 'abort',
      },
      {
        id: 'test',
        name: 'Run Tests',
        prompt: 'Run all tests and report results. Fix any failing tests if possible.',
        dependsOn: ['lint'],
        onFailure: 'abort',
      },
      {
        id: 'build',
        name: 'Build Check',
        prompt: 'Run build and verify it succeeds. Fix any build errors.',
        dependsOn: ['test'],
        onFailure: 'abort',
      },
      {
        id: 'pr',
        name: 'Create PR',
        prompt: 'Create a pull request with all changes made. Include a summary of fixes.',
        dependsOn: ['build'],
        onFailure: 'notify',
      },
    ],
  };
}

/**
 * 코드 리뷰 파이프라인 템플릿
 */
export function createReviewPipelineTemplate(projectPath: string, prNumber: string): WorkflowConfig {
  return {
    id: `review-pipeline-${Date.now()}`,
    name: 'Code Review Pipeline',
    description: 'Security → Quality → Tests → Approve',
    projectPath,
    onFailure: 'notify',
    steps: [
      {
        id: 'security',
        name: 'Security Review',
        prompt: `Review PR #${prNumber} for security vulnerabilities. Check for injection, auth issues, data exposure.`,
      },
      {
        id: 'quality',
        name: 'Code Quality',
        prompt: `Review PR #${prNumber} for code quality. Check naming, structure, SOLID principles.`,
      },
      {
        id: 'tests',
        name: 'Test Coverage',
        prompt: `Check if PR #${prNumber} has adequate test coverage. Suggest missing tests.`,
        dependsOn: ['security', 'quality'],  // 병렬 후 실행
      },
      {
        id: 'summary',
        name: 'Review Summary',
        prompt: 'Compile all review findings and create a summary comment on the PR.',
        dependsOn: ['tests'],
      },
    ],
  };
}

// ============================================
// Workflow Validation
// ============================================

/**
 * 워크플로우 유효성 검사
 */
export function validateWorkflow(workflow: WorkflowConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // 기본 필드 검사
  if (!workflow.id) errors.push('Workflow ID is required');
  if (!workflow.name) errors.push('Workflow name is required');
  if (!workflow.steps || workflow.steps.length === 0) {
    errors.push('Workflow must have at least one step');
  }

  // Step 검사
  const stepIds = new Set<string>();
  for (const step of workflow.steps || []) {
    if (!step.id) {
      errors.push('Each step must have an ID');
      continue;
    }

    if (stepIds.has(step.id)) {
      errors.push(`Duplicate step ID: ${step.id}`);
    }
    stepIds.add(step.id);

    if (!step.prompt) {
      errors.push(`Step "${step.id}" must have a prompt`);
    }

    // 의존성 검사
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        if (!stepIds.has(dep) && !workflow.steps.some(s => s.id === dep)) {
          errors.push(`Step "${step.id}" depends on unknown step "${dep}"`);
        }
      }
    }
  }

  // 순환 의존성 검사
  if (workflow.steps && workflow.steps.length > 0) {
    try {
      topologicalSort(workflow.steps);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ============================================
// Exports
// ============================================

export {
  WORKFLOW_DIR,
  EXECUTION_DIR,
};
