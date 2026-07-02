import { describe, expect, it } from 'vitest';
import {
  loadExecution,
  loadWorkflow,
  saveExecution,
  saveWorkflow,
  type WorkflowConfig,
  type WorkflowExecution,
} from './workflow.js';

const workflow = (id: string): WorkflowConfig => ({
  id,
  name: 'test workflow',
  projectPath: '/tmp/project',
  steps: [{ id: 'step', name: 'Step', prompt: 'Run step' }],
});

const execution = (executionId: string): WorkflowExecution => ({
  workflowId: 'workflow',
  executionId,
  status: 'running',
  startedAt: 0,
  stepResults: {},
});

describe('workflow storage IDs', () => {
  it('rejects workflow IDs that would escape the workflow directory', async () => {
    await expect(saveWorkflow(workflow('../outside'))).rejects.toThrow('Invalid storage ID');
    await expect(saveWorkflow(workflow('..\\outside'))).rejects.toThrow('Invalid storage ID');
    await expect(loadWorkflow('../outside')).resolves.toBeNull();
  });

  it('rejects execution IDs that would escape the execution directory', async () => {
    await expect(saveExecution(execution('../outside'))).rejects.toThrow('Invalid storage ID');
    await expect(saveExecution(execution('..\\outside'))).rejects.toThrow('Invalid storage ID');
    await expect(loadExecution('../outside')).resolves.toBeNull();
  });
});
