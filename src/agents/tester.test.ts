import { describe, it, expect } from 'vitest';
import { parseTesterOutput } from './tester.js';

// The tester is a BLOCKING stage. Its text fallback used "no error keyword ⇒
// success", so an empty/degenerate run faked a PASS and let unverified code
// through. Only genuinely empty output is now flagged — short-but-real output
// (e.g. "collected 0 items") must still pass. (INT-2521)
describe('parseTesterOutput fake-pass guard (INT-2521)', () => {
  it('empty output is NOT a pass — unverified', () => {
    const r = parseTesterOutput('');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/unverified|no output/i);
  });

  it('whitespace-only output is NOT a pass', () => {
    expect(parseTesterOutput('   \n\t  ').success).toBe(false);
  });

  it('real "N passed" output IS a pass', () => {
    expect(parseTesterOutput('5 passed, 0 failed in 1.2s').success).toBe(true);
  });

  it('a legitimate short "no tests" run still passes (not mis-flagged)', () => {
    expect(parseTesterOutput('collected 0 items').success).toBe(true);
  });

  it('a failing run is not a pass', () => {
    expect(parseTesterOutput('2 failed, 3 passed').success).toBe(false);
  });
});
