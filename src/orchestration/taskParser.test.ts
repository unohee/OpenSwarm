import { describe, expect, it } from 'vitest';
import { parseTask } from './taskParser.js';
import { validateWorkflow } from './workflow.js';

describe('parseTask workflow generation', () => {
  it('prefixes generated dependencies to match generated step IDs', () => {
    const parsed = parseTask({
      id: 'INT-1',
      title: 'fix broken dashboard refresh',
      description: 'The dashboard refresh is broken and needs a fix.',
    });

    expect(parsed.workflow.steps.map(step => step.id)).toEqual([
      'bug_fix-analyze',
      'bug_fix-fix',
      'bug_fix-test',
    ]);
    expect(parsed.workflow.steps[1].dependsOn).toEqual(['bug_fix-analyze']);
    expect(parsed.workflow.steps[2].dependsOn).toEqual(['bug_fix-fix']);
    expect(validateWorkflow(parsed.workflow)).toEqual({ valid: true, errors: [] });
  });
});
