import { describe, expect, it, vi } from 'vitest';
import { collectFixRuntimePreflightIssues } from './fixPreflight.js';

describe('collectFixRuntimePreflightIssues', () => {
  const config = { enabled: true, blockOnNewFailures: true, maxCommands: 4 };
  const plan = {
    commands: [{ name: 'pytest', run: 'python -m pytest -q', kind: 'test' as const }],
    packageJsonByDirectory: {},
  };

  it('accepts any repository ecosystem whose trusted verification runtime executes', async () => {
    const verify = vi.fn().mockResolvedValue({ success: false, testsFailed: 1 });
    await expect(collectFixRuntimePreflightIssues('/repo', config, plan, verify)).resolves.toEqual([]);
    expect(verify).toHaveBeenCalledWith('/repo', config, plan.commands, {});
  });

  it('blocks workers when the trusted verification runtime is unavailable', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('python: module pytest not found'));
    const issues = await collectFixRuntimePreflightIssues('/repo', config, plan, verify);
    expect(issues.join('\n')).toContain('before fix workers started');
    expect(issues.join('\n')).toContain('pytest not found');
  });

  it('does not invent a preflight when the repository has no trusted checks', async () => {
    const verify = vi.fn();
    await expect(collectFixRuntimePreflightIssues('/repo', config, {
      commands: [], packageJsonByDirectory: {},
    }, verify)).resolves.toEqual([]);
    expect(verify).not.toHaveBeenCalled();
  });
});
