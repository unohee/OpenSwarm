import { describe, expect, it } from 'vitest';
import { MIN_CI_CHECK_INTERVAL_MS, validateCIWorkerInterval } from './ciWorker.js';

describe('validateCIWorkerInterval', () => {
  it('accepts the default and minimum interval', () => {
    expect(validateCIWorkerInterval(undefined)).toBe(300_000);
    expect(validateCIWorkerInterval(MIN_CI_CHECK_INTERVAL_MS)).toBe(MIN_CI_CHECK_INTERVAL_MS);
  });

  it.each([NaN, Infinity, -1, 0, 999, 1000.5])('rejects invalid interval %s', (value) => {
    expect(() => validateCIWorkerInterval(value)).toThrow(/checkIntervalMs/);
  });
});
