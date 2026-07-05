import { describe, it, expect } from 'vitest';
import { buildRepeatEscalation } from './workerEscalation.js';
import type { RoleConfig } from '../core/types.js';

const workerCfg = (extra: Partial<RoleConfig> = {}): RoleConfig => ({
  enabled: true,
  model: 'base-model',
  timeoutMs: 0,
  ...extra,
});

describe('buildRepeatEscalation', () => {
  it('bumps effort to high when no escalateModel is configured (zero-config default)', () => {
    expect(buildRepeatEscalation({
      workerCfg: workerCfg(),
      currentIteration: 2,
      currentModel: 'base-model',
      currentEffort: 'low',
    })).toEqual({ model: undefined, reasoningEffort: 'high' });
  });

  it('escalates model and effort when escalateModel differs and effort is not high', () => {
    expect(buildRepeatEscalation({
      workerCfg: workerCfg({ escalateModel: 'bigger-model', escalateAfterIteration: 99 }),
      currentIteration: 2,
      currentModel: 'base-model',
      currentEffort: 'medium',
    })).toEqual({ model: 'bigger-model', reasoningEffort: 'high' });
  });

  it('treats an already-active iteration escalation as a model no-op (effort only)', () => {
    // Default escalateAfterIteration=2: iteration 3 would run escalateModel
    // anyway — re-targeting it adds nothing, only the effort bump counts.
    expect(buildRepeatEscalation({
      workerCfg: workerCfg({ escalateModel: 'bigger-model' }),
      currentIteration: 2,
      currentModel: 'base-model',
      currentEffort: 'low',
    })).toEqual({ model: undefined, reasoningEffort: 'high' });
  });

  it('returns undefined when nothing is left to escalate (abort path)', () => {
    // Iteration escalation already in effect AND effort already high.
    expect(buildRepeatEscalation({
      workerCfg: workerCfg({ escalateModel: 'bigger-model' }),
      currentIteration: 2,
      currentModel: 'base-model',
      currentEffort: 'high',
    })).toBeUndefined();
  });
});
