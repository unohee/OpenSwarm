import { describe, it, expect } from 'vitest';
import { TABS, nextTab, tabFromDigit } from './tabs.js';

describe('tabs (EPIC INT-1813 S3)', () => {
  it('exposes the 6 cockpit tabs in order', () => {
    expect(TABS.map((t) => t.id)).toEqual(['chat', 'projects', 'tasks', 'stuck', 'issues', 'logs']);
  });

  it('nextTab wraps both directions', () => {
    expect(nextTab(0, 1)).toBe(1);
    expect(nextTab(5, 1)).toBe(0); // forward wrap
    expect(nextTab(0, -1)).toBe(5); // backward wrap
    expect(nextTab(2, -1)).toBe(1);
  });

  it('tabFromDigit maps 1-based digits and rejects out-of-range / non-digits', () => {
    expect(tabFromDigit('1')).toBe(0);
    expect(tabFromDigit('6')).toBe(5);
    expect(tabFromDigit('7')).toBeNull();
    expect(tabFromDigit('0')).toBeNull();
    expect(tabFromDigit('x')).toBeNull();
    expect(tabFromDigit('')).toBeNull();
  });
});
