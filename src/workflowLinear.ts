// ============================================
// Claude Swarm - Linear Workflow Integration
// 워크플로우 Step을 Linear 이슈로 연동
// ============================================

import {
  WorkflowConfig,
  WorkflowStep,
  WorkflowExecution,
  StepResult,
  topologicalSort,
} from './workflow.js';

// ============================================
// Types
// ============================================

export interface LinearWorkflowOptions {
  /** 부모 이슈 ID (워크플로우 전체를 추적) */
  parentIssueId?: string;
  /** 팀 ID */
  teamId: string;
  /** 프로젝트 ID (선택) */
  projectId?: string;
  /** Step별 이슈 생성 여부 */
  createStepIssues?: boolean;
  /** 라벨 ID 목록 */
  labelIds?: string[];
}

export interface LinearStepIssue {
  stepId: string;
  issueId: string;
  issueIdentifier: string;  // e.g., "INT-123"
}

export interface WorkflowLinearSync {
  workflowId: string;
  executionId: string;
  parentIssueId?: string;
  stepIssues: LinearStepIssue[];
  createdAt: number;
}

// ============================================
// Linear MCP Integration
// ============================================

/**
 * Note: 이 모듈은 Linear MCP 서버가 연결되어 있을 때 사용합니다.
 * MCP 함수들은 Claude Code 런타임에서 자동으로 사용 가능합니다.
 *
 * 실제 연동은 Discord 명령어나 Claude 프롬프트에서 수행됩니다.
 * 이 모듈은 워크플로우와 Linear 이슈 간의 매핑 정보를 관리합니다.
 */

/**
 * 워크플로우를 Linear 이슈 구조로 변환
 */
export function workflowToLinearStructure(
  workflow: WorkflowConfig,
  options: LinearWorkflowOptions
): {
  parentIssue: {
    title: string;
    description: string;
    teamId: string;
    projectId?: string;
    labelIds?: string[];
  };
  stepIssues: Array<{
    stepId: string;
    title: string;
    description: string;
    blockedBy: string[];  // step IDs (나중에 issue IDs로 변환)
  }>;
} {
  const sortedSteps = topologicalSort(workflow.steps);

  // 부모 이슈 (워크플로우 전체)
  const parentIssue = {
    title: `[Workflow] ${workflow.name}`,
    description: buildWorkflowDescription(workflow),
    teamId: options.teamId,
    projectId: options.projectId,
    labelIds: options.labelIds,
  };

  // Step별 이슈
  const stepIssues = sortedSteps.map(step => ({
    stepId: step.id,
    title: `[${workflow.id}] ${step.name}`,
    description: buildStepDescription(step, workflow),
    blockedBy: step.dependsOn || [],
  }));

  return { parentIssue, stepIssues };
}

/**
 * 워크플로우 설명 생성
 */
function buildWorkflowDescription(workflow: WorkflowConfig): string {
  const parts: string[] = [];

  parts.push(`## ${workflow.name}`);
  if (workflow.description) {
    parts.push(workflow.description);
  }
  parts.push('');

  parts.push('### Steps');
  for (const step of workflow.steps) {
    const deps = step.dependsOn ? ` (← ${step.dependsOn.join(', ')})` : '';
    parts.push(`- [ ] **${step.name}** (\`${step.id}\`)${deps}`);
  }
  parts.push('');

  parts.push('### Execution Flow');
  parts.push('```');
  const sortedSteps = topologicalSort(workflow.steps);
  parts.push(sortedSteps.map(s => s.id).join(' → '));
  parts.push('```');
  parts.push('');

  parts.push('---');
  parts.push('_Managed by Claude Swarm Workflow Engine_');

  return parts.join('\n');
}

/**
 * Step 설명 생성
 */
function buildStepDescription(step: WorkflowStep, workflow: WorkflowConfig): string {
  const parts: string[] = [];

  parts.push(`## Step: ${step.name}`);
  parts.push('');

  parts.push('### Prompt');
  parts.push('```');
  parts.push(step.prompt);
  parts.push('```');
  parts.push('');

  if (step.dependsOn && step.dependsOn.length > 0) {
    parts.push('### Dependencies');
    parts.push(step.dependsOn.map(d => `- \`${d}\``).join('\n'));
    parts.push('');
  }

  parts.push('### Configuration');
  parts.push(`- **On Failure:** ${step.onFailure || workflow.onFailure || 'abort'}`);
  if (step.timeout) {
    parts.push(`- **Timeout:** ${step.timeout}s`);
  }
  if (step.retryCount) {
    parts.push(`- **Retries:** ${step.retryCount}`);
  }
  parts.push('');

  parts.push('---');
  parts.push(`_Part of workflow: ${workflow.name}_`);

  return parts.join('\n');
}

/**
 * Step 결과를 Linear 코멘트로 변환
 */
export function stepResultToComment(result: StepResult): string {
  const parts: string[] = [];

  const statusEmoji = {
    pending: '⏳',
    running: '🔄',
    completed: '✅',
    failed: '❌',
    skipped: '⏭️',
  }[result.status];

  parts.push(`## ${statusEmoji} Step Result`);
  parts.push('');

  parts.push(`**Status:** ${result.status}`);
  parts.push(`**Started:** ${new Date(result.startedAt).toISOString()}`);
  if (result.completedAt) {
    const duration = (result.completedAt - result.startedAt) / 1000;
    parts.push(`**Completed:** ${new Date(result.completedAt).toISOString()}`);
    parts.push(`**Duration:** ${duration.toFixed(1)}s`);
  }
  parts.push('');

  if (result.output) {
    parts.push('### Output');
    parts.push('```');
    parts.push(result.output.slice(0, 3000));  // Linear 코멘트 길이 제한
    if (result.output.length > 3000) {
      parts.push('... (truncated)');
    }
    parts.push('```');
  }

  if (result.error) {
    parts.push('### Error');
    parts.push('```');
    parts.push(result.error);
    parts.push('```');
  }

  if (result.changedFiles && result.changedFiles.length > 0) {
    parts.push('### Changed Files');
    parts.push(result.changedFiles.map(f => `- \`${f}\``).join('\n'));
  }

  return parts.join('\n');
}

/**
 * Step 상태를 Linear 상태로 매핑
 */
export function stepStatusToLinearState(status: StepResult['status']): string {
  const mapping: Record<typeof status, string> = {
    pending: 'Todo',
    running: 'In Progress',
    completed: 'Done',
    failed: 'Canceled',
    skipped: 'Canceled',
  };
  return mapping[status] || 'Todo';
}

/**
 * 워크플로우 실행 요약 생성 (프로젝트 업데이트용)
 */
export function createExecutionSummary(execution: WorkflowExecution): {
  body: string;
  health: 'onTrack' | 'atRisk' | 'offTrack';
} {
  const results = Object.values(execution.stepResults);
  const completed = results.filter(r => r.status === 'completed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const total = results.length;

  // Health 결정
  let health: 'onTrack' | 'atRisk' | 'offTrack';
  if (failed > 0) {
    health = 'offTrack';
  } else if (completed < total) {
    health = 'atRisk';
  } else {
    health = 'onTrack';
  }

  // 요약 생성
  const parts: string[] = [];

  parts.push(`## Workflow Execution: ${execution.workflowId}`);
  parts.push('');
  parts.push(`**Execution ID:** \`${execution.executionId}\``);
  parts.push(`**Status:** ${execution.status}`);
  parts.push(`**Progress:** ${completed}/${total} steps completed`);
  parts.push('');

  parts.push('### Step Summary');
  parts.push('| Step | Status | Duration |');
  parts.push('|------|--------|----------|');

  for (const [stepId, result] of Object.entries(execution.stepResults)) {
    const duration = result.completedAt
      ? `${((result.completedAt - result.startedAt) / 1000).toFixed(1)}s`
      : '-';
    const statusIcon = {
      pending: '⏳',
      running: '🔄',
      completed: '✅',
      failed: '❌',
      skipped: '⏭️',
    }[result.status];
    parts.push(`| ${stepId} | ${statusIcon} ${result.status} | ${duration} |`);
  }
  parts.push('');

  if (failed > 0) {
    parts.push('### Failures');
    for (const [stepId, result] of Object.entries(execution.stepResults)) {
      if (result.status === 'failed' && result.error) {
        parts.push(`- **${stepId}:** ${result.error}`);
      }
    }
  }

  return { body: parts.join('\n'), health };
}

// ============================================
// Linear MCP Command Templates
// ============================================

/**
 * Linear 이슈 생성 명령 템플릿 (MCP용)
 */
export function getCreateIssueCommand(
  title: string,
  description: string,
  teamId: string,
  options?: {
    projectId?: string;
    parentId?: string;
    labelIds?: string[];
    blockedBy?: string[];
  }
): {
  tool: string;
  params: Record<string, unknown>;
} {
  return {
    tool: 'mcp__linear-server__create_issue',
    params: {
      title,
      description,
      team: teamId,
      project: options?.projectId,
      parentId: options?.parentId,
      labels: options?.labelIds,
      blockedBy: options?.blockedBy,
    },
  };
}

/**
 * Linear 이슈 상태 업데이트 명령 템플릿
 */
export function getUpdateIssueCommand(
  issueId: string,
  state: string
): {
  tool: string;
  params: Record<string, unknown>;
} {
  return {
    tool: 'mcp__linear-server__update_issue',
    params: {
      id: issueId,
      state,
    },
  };
}

/**
 * Linear 코멘트 생성 명령 템플릿
 */
export function getCreateCommentCommand(
  issueId: string,
  body: string
): {
  tool: string;
  params: Record<string, unknown>;
} {
  return {
    tool: 'mcp__linear-server__create_comment',
    params: {
      issueId,
      body,
    },
  };
}

/**
 * Linear 프로젝트 업데이트 명령 템플릿
 */
export function getCreateProjectUpdateCommand(
  projectId: string,
  body: string,
  health: 'onTrack' | 'atRisk' | 'offTrack'
): {
  tool: string;
  params: Record<string, unknown>;
} {
  return {
    tool: 'mcp__linear-server__create_project_update',
    params: {
      project: projectId,
      body,
      health,
    },
  };
}
