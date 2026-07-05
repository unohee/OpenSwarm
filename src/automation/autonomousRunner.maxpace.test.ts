// Purpose: max pace ("turbo") is ON by default and never auto-expires, so a
// daemon restart no longer silently drops back to normal pace. (always-max)
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

describe('AutonomousRunner max pace', () => {
  it('is ON by default (fresh construction / restart)', () => {
    const r = new AutonomousRunner(cfg());
    expect(r.getTurboMode()).toBe(true);
    expect(r.getStats().turboMode).toBe(true);
    // No expiry countdown — it must not regress on its own.
    expect(r.getStats().turboExpiresAt).toBeNull();
  });

  it('stays on with no expiry when re-enabled', () => {
    const r = new AutonomousRunner(cfg());
    r.setTurboMode(true);
    expect(r.getTurboMode()).toBe(true);
    expect(r.getStats().turboExpiresAt).toBeNull();
  });

  it('can still be toggled off as an escape hatch', () => {
    const r = new AutonomousRunner(cfg());
    r.setTurboMode(false);
    expect(r.getTurboMode()).toBe(false);
    expect(r.getStats().turboExpiresAt).toBeNull();
  });
});
