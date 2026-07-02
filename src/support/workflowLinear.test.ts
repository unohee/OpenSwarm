import { describe, expect, it } from 'vitest';
import { createExecutionSummary, stepResultToComment } from './workflowLinear.js';
import type { StepResult, WorkflowExecution } from '../orchestration/workflow.js';

const failedStep = (error: string): StepResult => ({
  stepId: 'step-1',
  status: 'failed',
  startedAt: 1,
  completedAt: 2,
  error,
});

describe('workflowLinear', () => {
  it('truncates long step errors in Linear comments', () => {
    const error = 'E'.repeat(4000);
    const comment = stepResultToComment(failedStep(error));

    expect(comment).toContain('... (truncated)');
    expect(comment).not.toContain('E'.repeat(3500));
  });

  it('truncates long failure errors in execution summaries', () => {
    const error = 'F'.repeat(1200);
    const execution: WorkflowExecution = {
      workflowId: 'wf-1',
      executionId: 'exec-1',
      status: 'failed',
      startedAt: 1,
      stepResults: {
        'step-1': failedStep(error),
      },
    };

    const summary = createExecutionSummary(execution);

    expect(summary.health).toBe('offTrack');
    expect(summary.body).toContain('... (truncated)');
    expect(summary.body).not.toContain('F'.repeat(800));
  });
});
