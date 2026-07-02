import { describe, it, expect } from 'vitest';
import { TABS, nextTab, tabFromDigit } from './tabs.js';

describe('tabs (EPIC INT-1813 S3)', () => {
  it('exposes the cockpit tabs in order (Pipeline added in S5)', () => {
    expect(TABS.map((t) => t.id)).toEqual(['chat', 'pipeline', 'projects', 'tasks', 'stuck', 'issues', 'logs']);
  });

  it('nextTab wraps both directions', () => {
    const last = TABS.length - 1;
    expect(nextTab(0, 1)).toBe(1);
    expect(nextTab(last, 1)).toBe(0); // forward wrap
    expect(nextTab(0, -1)).toBe(last); // backward wrap
    expect(nextTab(2, -1)).toBe(1);
  });

  it('nextTab rejects invalid totals instead of returning NaN', () => {
    expect(nextTab(0, 1, 0)).toBe(0);
    expect(nextTab(0, 1, -1)).toBe(0);
    expect(nextTab(0, 1, Number.NaN)).toBe(0);
  });

  it('nextTab rejects invalid current and delta values', () => {
    expect(nextTab(Number.NaN, 1)).toBe(0);
    expect(nextTab(0.5, 1)).toBe(0);
    expect(nextTab(0, Number.NaN)).toBe(0);
    expect(nextTab(0, 1.5)).toBe(0);
  });

  it('tabFromDigit maps 1-based digits and rejects out-of-range / non-digits', () => {
    expect(tabFromDigit('1')).toBe(0);
    expect(tabFromDigit('7')).toBe(6);
    expect(tabFromDigit('8')).toBeNull();
    expect(tabFromDigit('0')).toBeNull();
    expect(tabFromDigit('x')).toBeNull();
    expect(tabFromDigit('')).toBeNull();
    expect(tabFromDigit('1e0')).toBeNull();
    expect(tabFromDigit('0x1')).toBeNull();
    expect(tabFromDigit(' 1')).toBeNull();
    expect(tabFromDigit('1.0')).toBeNull();
  });
});
