import { describe, expect, it } from 'vitest';
import { PkceSettlement } from './pkceSettlement.js';

describe('PkceSettlement', () => {
  it('allows exactly one callback to claim an exchange', () => {
    const settlement = new PkceSettlement();
    expect(settlement.tryClaim()).toBe(true);
    expect(settlement.tryClaim()).toBe(false);
    expect(settlement.finish()).toBe(true);
    expect(settlement.finish()).toBe(false);
    expect(settlement.settled).toBe(true);
  });
});
