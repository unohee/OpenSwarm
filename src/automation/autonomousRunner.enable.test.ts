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

describe('AutonomousRunner project-selection gating (INT-2207)', () => {
  // shouldFilterByEnabled is private; the gating behavior is what matters.
  type Internal = { shouldFilterByEnabled(): boolean };
  const filtersOn = (r: AutonomousRunner) => (r as unknown as Internal).shouldFilterByEnabled();

  it('untouched + empty → filter OFF (legacy run-all fallback)', () => {
    const r = new AutonomousRunner(cfg());
    expect(r.getEnabledProjects()).toHaveLength(0);
    expect(filtersOn(r)).toBe(false); // no explicit selection yet → run all allowed
  });

  it('disabling every project → filter ON even though empty → nothing runs', () => {
    const r = new AutonomousRunner(cfg({ allowedProjects: ['/x/a'] }));
    r.enableProject('/x/a');
    expect(filtersOn(r)).toBe(true);
    r.disableProject('/x/a');
    expect(r.getEnabledProjects()).toHaveLength(0);
    // The bug: empty used to mean "run all". Now touched → filter stays ON, so an
    // empty enabled-set means nothing runs.
    expect(filtersOn(r)).toBe(true);
  });

  it('disabling alone (no prior enable) still touches the selection', () => {
    const r = new AutonomousRunner(cfg());
    r.disableProject('/x/a');
    expect(filtersOn(r)).toBe(true);
  });
});
