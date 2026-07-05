import { describe, it, expect } from 'vitest';
import { stageTimeoutMs } from './pairPipeline.js';

// A stage timeout of 0/undefined must NOT mean "unlimited" — that let a stalled
// CLI/loop hang the whole daemon (INT-2521). It falls back to a per-stage ceiling.
describe('stageTimeoutMs (INT-2521)', () => {
  it('falls back to a positive per-stage ceiling for 0 / undefined (never unlimited)', () => {
    expect(stageTimeoutMs('worker', 0)).toBeGreaterThan(0);
    expect(stageTimeoutMs('worker', undefined)).toBeGreaterThan(0);
    expect(stageTimeoutMs('reviewer', 0)).toBeGreaterThan(0);
    expect(stageTimeoutMs('tester', 0)).toBeGreaterThan(0);
  });

  it('gives the worker a longer ceiling than the reviewer', () => {
    expect(stageTimeoutMs('worker', 0)).toBeGreaterThan(stageTimeoutMs('reviewer', 0));
  });

  it('honors a positive configured value verbatim', () => {
    expect(stageTimeoutMs('worker', 90_000)).toBe(90_000);
    expect(stageTimeoutMs('reviewer', 45_000)).toBe(45_000);
  });

  it('an unknown stage still gets a positive ceiling', () => {
    expect(stageTimeoutMs('mystery-stage', 0)).toBeGreaterThan(0);
  });
});
