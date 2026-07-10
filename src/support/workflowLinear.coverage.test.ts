// Coverage-focused tests for workflowLinear.ts, complementing workflowLinear.test.ts.
// Targets: workflowToLinearStructure (+ internal description builders), the
// stepResultToComment output/changedFiles branches, stepStatusToLinearState,
// the atRisk/onTrack branches of createExecutionSummary, and the Linear MCP
// command template builders.
import { describe, expect, it } from 'vitest';
import {
  workflowToLinearStructure,
  stepResultToComment,
  stepStatusToLinearState,
  createExecutionSummary,
  getCreateIssueCommand,
  getUpdateIssueCommand,
  getCreateCommentCommand,
  getCreateProjectUpdateCommand,
} from './workflowLinear.js';
import type {
  WorkflowConfig,
  WorkflowStep,
  StepResult,
  WorkflowExecution,
} from '../orchestration/workflow.js';

const baseStep = (patch: Partial<WorkflowStep>): WorkflowStep => ({
  id: 'step-1',
  name: 'Step One',
  prompt: 'do the thing',
  ...patch,
});

describe('workflowToLinearStructure', () => {
  it('builds a parent issue and per-step issues, sorted topologically', () => {
    const workflow: WorkflowConfig = {
      id: 'wf-1',
      name: 'My Workflow',
      description: 'A description of the workflow',
      projectPath: '/tmp/proj',
      onFailure: 'retry',
      steps: [
        baseStep({ id: 'b', name: 'Step B', dependsOn: ['a'] }),
        baseStep({
          id: 'a',
          name: 'Step A',
          onFailure: 'skip',
          timeout: 30,
          retryCount: 2,
        }),
      ],
    };

    const result = workflowToLinearStructure(workflow, {
      teamId: 'team-1',
      projectId: 'proj-1',
      parentIssueId: 'parent-1',
      createStepIssues: true,
      labelIds: ['label-a'],
    });

    expect(result.parentIssue.title).toBe('[Workflow] My Workflow');
    expect(result.parentIssue.teamId).toBe('team-1');
    expect(result.parentIssue.projectId).toBe('proj-1');
    expect(result.parentIssue.labelIds).toEqual(['label-a']);
    expect(result.parentIssue.description).toContain('## My Workflow');
    expect(result.parentIssue.description).toContain('A description of the workflow');
    expect(result.parentIssue.description).toContain('- [ ] **Step B** (`b`) (← a)');
    expect(result.parentIssue.description).toContain('a → b');
    expect(result.parentIssue.description).toContain('_Managed by OpenSwarm Workflow Engine_');

    // Sorted so 'a' (the dependency) comes before 'b'.
    expect(result.stepIssues.map(s => s.stepId)).toEqual(['a', 'b']);

    const stepA = result.stepIssues.find(s => s.stepId === 'a')!;
    expect(stepA.title).toBe('[wf-1] Step A');
    expect(stepA.description).toContain('### Prompt');
    expect(stepA.description).toContain('do the thing');
    expect(stepA.description).toContain('**On Failure:** skip');
    expect(stepA.description).toContain('**Timeout:** 30s');
    expect(stepA.description).toContain('**Retries:** 2');
    expect(stepA.description).toContain('_Part of workflow: My Workflow_');
    expect(stepA.blockedBy).toEqual([]);

    const stepB = result.stepIssues.find(s => s.stepId === 'b')!;
    expect(stepB.description).toContain('### Dependencies');
    expect(stepB.description).toContain('- `a`');
    expect(stepB.blockedBy).toEqual(['a']);
  });

  it('omits optional workflow description and falls back to workflow-level onFailure', () => {
    const workflow: WorkflowConfig = {
      id: 'wf-2',
      name: 'No Description Workflow',
      projectPath: '/tmp/proj2',
      steps: [baseStep({ id: 'only', name: 'Only Step' })],
    };

    const result = workflowToLinearStructure(workflow, { teamId: 'team-2' });

    // No description → the paragraph is simply skipped, no leftover "undefined".
    expect(result.parentIssue.description).not.toContain('undefined');
    expect(result.parentIssue.projectId).toBeUndefined();
    expect(result.parentIssue.labelIds).toBeUndefined();

    // Step has no per-step onFailure and workflow has none either → default 'abort'.
    const step = result.stepIssues[0];
    expect(step.description).toContain('**On Failure:** abort');
    expect(step.description).not.toContain('### Dependencies');
    expect(step.description).not.toContain('**Timeout:**');
    expect(step.description).not.toContain('**Retries:**');
  });
});

describe('stepResultToComment - output and changedFiles branches', () => {
  it('includes an Output section when result.output is present', () => {
    const result: StepResult = {
      stepId: 'step-1',
      status: 'completed',
      startedAt: 1000,
      completedAt: 2500,
      output: 'build succeeded',
    };

    const comment = stepResultToComment(result);

    expect(comment).toContain('### Output');
    expect(comment).toContain('build succeeded');
    expect(comment).toContain('**Duration:** 1.5s');
    expect(comment).not.toContain('### Error');
    expect(comment).not.toContain('### Changed Files');
  });

  it('includes a Changed Files section when changedFiles is non-empty', () => {
    const result: StepResult = {
      stepId: 'step-1',
      status: 'completed',
      startedAt: 1000,
      changedFiles: ['src/a.ts', 'src/b.ts'],
    };

    const comment = stepResultToComment(result);

    expect(comment).toContain('### Changed Files');
    expect(comment).toContain('- `src/a.ts`');
    expect(comment).toContain('- `src/b.ts`');
    // No completedAt → no Duration/Completed line.
    expect(comment).not.toContain('**Duration:**');
  });

  it('omits Changed Files section when the array is empty', () => {
    const result: StepResult = {
      stepId: 'step-1',
      status: 'pending',
      startedAt: 1000,
      changedFiles: [],
    };

    const comment = stepResultToComment(result);

    expect(comment).not.toContain('### Changed Files');
  });
});

describe('stepStatusToLinearState', () => {
  it('maps every step status to its Linear state', () => {
    expect(stepStatusToLinearState('pending')).toBe('Todo');
    expect(stepStatusToLinearState('running')).toBe('In Progress');
    expect(stepStatusToLinearState('completed')).toBe('Done');
    expect(stepStatusToLinearState('failed')).toBe('Canceled');
    expect(stepStatusToLinearState('skipped')).toBe('Canceled');
  });
});

describe('createExecutionSummary - health branches', () => {
  const stepResult = (patch: Partial<StepResult>): StepResult => ({
    stepId: 'step-1',
    status: 'completed',
    startedAt: 1000,
    completedAt: 2000,
    ...patch,
  });

  it('reports atRisk when some steps are still incomplete and none failed', () => {
    const execution: WorkflowExecution = {
      workflowId: 'wf-1',
      executionId: 'exec-1',
      status: 'running',
      startedAt: 1,
      stepResults: {
        a: stepResult({ stepId: 'a', status: 'completed' }),
        b: stepResult({ stepId: 'b', status: 'pending', completedAt: undefined }),
      },
    };

    const summary = createExecutionSummary(execution);

    expect(summary.health).toBe('atRisk');
    expect(summary.body).toContain('Progress:** 1/2 steps completed');
    // Pending step has no completedAt → duration column renders as '-'.
    expect(summary.body).toContain('| b | ⏳ pending | - |');
  });

  it('reports onTrack when every step has completed', () => {
    const execution: WorkflowExecution = {
      workflowId: 'wf-1',
      executionId: 'exec-2',
      status: 'completed',
      startedAt: 1,
      stepResults: {
        a: stepResult({ stepId: 'a' }),
        b: stepResult({ stepId: 'b' }),
      },
    };

    const summary = createExecutionSummary(execution);

    expect(summary.health).toBe('onTrack');
    expect(summary.body).toContain('Progress:** 2/2 steps completed');
    expect(summary.body).not.toContain('### Failures');
  });
});

describe('Linear MCP command templates', () => {
  it('builds a create-issue command with all optional fields', () => {
    const cmd = getCreateIssueCommand('Title', 'Description', 'team-1', {
      projectId: 'proj-1',
      parentId: 'parent-1',
      labelIds: ['l1'],
      blockedBy: ['b1'],
    });

    expect(cmd.tool).toBe('mcp__linear-server__create_issue');
    expect(cmd.params).toEqual({
      title: 'Title',
      description: 'Description',
      team: 'team-1',
      project: 'proj-1',
      parentId: 'parent-1',
      labels: ['l1'],
      blockedBy: ['b1'],
    });
  });

  it('builds a create-issue command without options', () => {
    const cmd = getCreateIssueCommand('Title', 'Description', 'team-1');

    expect(cmd.params.project).toBeUndefined();
    expect(cmd.params.parentId).toBeUndefined();
    expect(cmd.params.labels).toBeUndefined();
    expect(cmd.params.blockedBy).toBeUndefined();
  });

  it('builds an update-issue command', () => {
    const cmd = getUpdateIssueCommand('issue-1', 'Done');

    expect(cmd.tool).toBe('mcp__linear-server__update_issue');
    expect(cmd.params).toEqual({ id: 'issue-1', state: 'Done' });
  });

  it('builds a create-comment command', () => {
    const cmd = getCreateCommentCommand('issue-1', 'Body text');

    expect(cmd.tool).toBe('mcp__linear-server__create_comment');
    expect(cmd.params).toEqual({ issueId: 'issue-1', body: 'Body text' });
  });

  it('builds a create-project-update command', () => {
    const cmd = getCreateProjectUpdateCommand('proj-1', 'Body text', 'atRisk');

    expect(cmd.tool).toBe('mcp__linear-server__create_project_update');
    expect(cmd.params).toEqual({ project: 'proj-1', body: 'Body text', health: 'atRisk' });
  });
});
