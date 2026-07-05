import { describe, it, expect } from 'vitest';
import { detectInfeasibleDoD, shouldEarlyStuckForInfeasibility } from './feasibilityDetector.js';

describe('detectInfeasibleDoD (INT-2521 ⑦)', () => {
  it('flags explicit human/manual requirements', () => {
    expect(detectInfeasibleDoD('This step needs human review before it can proceed.').infeasible).toBe(true);
    expect(detectInfeasibleDoD('Requires manual database seeding on a real server.').infeasible).toBe(true);
    expect(detectInfeasibleDoD('This cannot be automated; a person must run the migration.').infeasible).toBe(true);
    expect(detectInfeasibleDoD('Deployment requires human intervention.').infeasible).toBe(true);
  });

  it('flags explicit impossibility of the DoD in the sandbox', () => {
    expect(detectInfeasibleDoD('The idempotency check cannot be verified in this environment (DB is 0 bytes).').infeasible).toBe(true);
    expect(detectInfeasibleDoD('This is structurally impossible without the production data.').infeasible).toBe(true);
    expect(detectInfeasibleDoD('The acceptance criteria are not possible in the sandbox.').infeasible).toBe(true);
    expect(detectInfeasibleDoD('This task is infeasible in this environment.').infeasible).toBe(true);
  });

  it('flags absent environment resources the DoD needs (impossibility-anchored)', () => {
    expect(detectInfeasibleDoD('The test needs a live API but there is no network access here.').infeasible).toBe(true);
    expect(detectInfeasibleDoD('This requires access to production to reproduce.').infeasible).toBe(true);
    expect(detectInfeasibleDoD('There is no database available to run the migration against.').infeasible).toBe(true);
  });

  it('returns the matched marker for the STUCK diagnostic', () => {
    const v = detectInfeasibleDoD('Verifying idempotency here is structurally impossible without the real table.');
    expect(v.infeasible).toBe(true);
    expect(v.marker).toBe('structurally impossible');
  });

  it('does NOT flag a merely-hard-but-doable task (progress, not a wall)', () => {
    expect(detectInfeasibleDoD('The null check is missing on line 42; add it and re-run the tests.').infeasible).toBe(false);
    expect(detectInfeasibleDoD('Reviewer rejected: the function returns the wrong shape.').infeasible).toBe(false);
    expect(detectInfeasibleDoD('Tests failed: expected 3 to equal 4.').infeasible).toBe(false);
    expect(detectInfeasibleDoD('This is a hard refactor but the approach is sound; keep going.').infeasible).toBe(false);
  });

  it('does NOT false-positive on ordinary feedback that merely mentions the resource nouns', () => {
    // bare nouns must NOT match — only impossibility-anchored phrases do
    expect(detectInfeasibleDoD('Add a retry to the network access layer.').infeasible).toBe(false);
    expect(detectInfeasibleDoD('Do not hardcode the production database URL; read it from env.').infeasible).toBe(false);
    expect(detectInfeasibleDoD('The manual explains the database schema well.').infeasible).toBe(false);
    expect(detectInfeasibleDoD('Implement human-friendly error messages.').infeasible).toBe(false);
  });

  it('handles empty / non-string inputs safely', () => {
    expect(detectInfeasibleDoD('').infeasible).toBe(false);
    expect(detectInfeasibleDoD('   ').infeasible).toBe(false);
    expect(detectInfeasibleDoD(undefined).infeasible).toBe(false);
    expect(detectInfeasibleDoD(null).infeasible).toBe(false);
    expect(detectInfeasibleDoD(new Error('needs human review')).infeasible).toBe(true);
  });
});

describe('shouldEarlyStuckForInfeasibility (INT-2521 ⑦)', () => {
  const INFEASIBLE = 'The idempotency guarantee cannot be verified in this environment: the database is 0 bytes.';
  const INFEASIBLE_2 = 'This requires access to production to reproduce; no database available here.';
  const HARD_BUT_DOABLE = 'Reviewer rejected: the dedup key is wrong — use (trade_id, filled_at) and re-run.';
  const UNRELATED_FAIL = 'Tests failed: expected 3 to equal 4.';

  it('short-circuits when the current AND prior failures are both infeasible (markers may differ)', () => {
    // Two consecutive infeasibility signals — the markers need NOT be identical
    // ("cannot verify in this environment" then "requires access to production" are
    // both facets of the same wall); what matters is that infeasibility recurred.
    expect(shouldEarlyStuckForInfeasibility(INFEASIBLE, INFEASIBLE_2).earlyStuck).toBe(true);
    expect(shouldEarlyStuckForInfeasibility(INFEASIBLE, INFEASIBLE).earlyStuck).toBe(true);
  });

  it('never short-circuits on the very FIRST attempt (no prior detail yet)', () => {
    const v = shouldEarlyStuckForInfeasibility(INFEASIBLE, '');
    expect(v.earlyStuck).toBe(false);
    expect(v.infeasible).toBe(true); // detected on the current failure, but not yet trusted
    expect(shouldEarlyStuckForInfeasibility(INFEASIBLE, undefined).earlyStuck).toBe(false);
  });

  it('never short-circuits when the PRIOR failure was unrelated (the false-positive to avoid)', () => {
    // A single (possibly false-positive) infeasibility marker that merely FOLLOWS an
    // ordinary failure must keep retrying — the prior failure was a different problem.
    expect(shouldEarlyStuckForInfeasibility(INFEASIBLE, UNRELATED_FAIL).earlyStuck).toBe(false);
    expect(shouldEarlyStuckForInfeasibility(INFEASIBLE, HARD_BUT_DOABLE).earlyStuck).toBe(false);
  });

  it('never short-circuits when the current failure is a merely-hard-but-doable one', () => {
    expect(shouldEarlyStuckForInfeasibility(HARD_BUT_DOABLE, INFEASIBLE).earlyStuck).toBe(false);
    expect(shouldEarlyStuckForInfeasibility(HARD_BUT_DOABLE, HARD_BUT_DOABLE).earlyStuck).toBe(false);
  });

  it('surfaces the CURRENT failure marker for the STUCK diagnostic', () => {
    const v = shouldEarlyStuckForInfeasibility('This requires human intervention now.', INFEASIBLE);
    expect(v.earlyStuck).toBe(true);
    expect(v.marker).toBe('requires human');
  });
});
