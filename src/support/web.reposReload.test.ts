import { describe, it, expect, beforeEach } from 'vitest';
import { applyReposConfig } from './web.js';
import type { AutonomousRunner } from '../automation/autonomousRunner.js';

// Minimal stub of the AutonomousRunner surface applyReposConfig touches, so we
// can assert how a fresh repos.json is reconciled onto the runner without a
// daemon. This is the load-bearing behavior behind "CLI `add` shows up in the
// dashboard without a restart".
function makeRunner(initialEnabled: string[] = [], initialAllowed: string[] = []) {
  const enabled = new Set(initialEnabled);
  let allowed = [...initialAllowed];
  const registered: Record<string, string> = {};
  return {
    enableProject: (p: string) => { enabled.add(p); },
    disableProject: (p: string) => { enabled.delete(p); },
    getEnabledProjects: () => [...enabled],
    getAllowedProjects: () => [...allowed],
    updateAllowedProjects: (paths: string[]) => { allowed = [...paths]; },
    registerProjectPath: (name: string, path: string) => { registered[name] = path; },
    _enabled: enabled,
    _allowed: () => allowed,
    _registered: registered,
  };
}

const cfg = (over: Partial<Record<'pinned' | 'enabled' | 'basePaths' | 'removedConfigPaths', string[]>> = {}) => ({
  pinned: [], enabled: [], basePaths: [], removedConfigPaths: [], ...over,
});

describe('applyReposConfig — repos.json → runner reconciliation', () => {
  let runner: ReturnType<typeof makeRunner>;
  beforeEach(() => { runner = makeRunner(); });

  it('enables a newly added repo and makes it allowed', () => {
    applyReposConfig(runner as unknown as AutonomousRunner, cfg({ enabled: ['/dev/WAVE'] }));
    expect(runner.getEnabledProjects()).toContain('/dev/WAVE');
    expect(runner._allowed()).toContain('/dev/WAVE');
  });

  it('disables a repo dropped from enabled (file is authoritative)', () => {
    runner = makeRunner(['/dev/OLD'], ['/dev/OLD']);
    applyReposConfig(runner as unknown as AutonomousRunner, cfg({ enabled: ['/dev/NEW'] }));
    expect(runner.getEnabledProjects()).toEqual(['/dev/NEW']);
  });

  it('never enables/allows a denylisted repo even if it lingers in enabled', () => {
    applyReposConfig(
      runner as unknown as AutonomousRunner,
      cfg({ enabled: ['/dev/WAVE'], removedConfigPaths: ['/dev/WAVE'] }),
    );
    expect(runner.getEnabledProjects()).not.toContain('/dev/WAVE');
    expect(runner._allowed()).not.toContain('/dev/WAVE');
  });

  it('pre-seeds the name→path cache for pinned and enabled repos', () => {
    applyReposConfig(
      runner as unknown as AutonomousRunner,
      cfg({ pinned: ['/dev/OpenSwarm'], enabled: ['/dev/WAVE'] }),
    );
    expect(runner._registered).toMatchObject({ OpenSwarm: '/dev/OpenSwarm', WAVE: '/dev/WAVE' });
  });

  it('is idempotent — applying the same config twice changes nothing further', () => {
    const c = cfg({ enabled: ['/dev/WAVE'] });
    applyReposConfig(runner as unknown as AutonomousRunner, c);
    const after1 = [...runner.getEnabledProjects()].sort();
    applyReposConfig(runner as unknown as AutonomousRunner, c);
    expect([...runner.getEnabledProjects()].sort()).toEqual(after1);
  });
});
