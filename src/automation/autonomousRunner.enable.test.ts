// Purpose: enableProject must also add the repo to allowedProjects so
// resolveProjectPath reads its openswarm.json mapping (INT-1973).
import { describe, it, expect } from 'vitest';
import { AutonomousRunner } from './autonomousRunner.js';
import type { AutonomousConfig } from './runnerTypes.js';

const cfg = (over: Partial<AutonomousConfig> = {}): AutonomousConfig => ({
  linearTeamId: 'team',
  allowedProjects: ['/x/a'],
  heartbeatSchedule: '0 * * * *',
  autoExecute: false,
  maxConsecutiveTasks: 1,
  cooldownSeconds: 0,
  dryRun: true,
  ...over,
});

describe('AutonomousRunner.enableProject (INT-1973)', () => {
  it('enabling a repo also allows it (resolveProjectPath reads only allowed paths)', () => {
    const r = new AutonomousRunner(cfg());
    r.enableProject('/x/wave');
    expect(r.getEnabledProjects()).toContain('/x/wave');
    expect(r.getAllowedProjects()).toContain('/x/wave');
  });

  it('does not duplicate an already-allowed path', () => {
    const r = new AutonomousRunner(cfg({ allowedProjects: ['/x/a'] }));
    r.enableProject('/x/a');
    expect(r.getAllowedProjects().filter((p) => p === '/x/a')).toHaveLength(1);
    expect(r.getEnabledProjects()).toContain('/x/a');
  });
});
