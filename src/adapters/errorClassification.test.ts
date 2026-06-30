import { describe, it, expect } from 'vitest';
import { isInfraError } from './errorClassification.js';

describe('isInfraError (INT-2010)', () => {
  it('flags CLI non-zero exit as infra (the production STUCK driver)', () => {
    expect(isInfraError(new Error('codex CLI failed with code 1: Reading prompt from stdin...'))).toBe(true);
    expect(isInfraError(new Error('Reviewer execution failed: claude CLI failed with code 1'))).toBe(true);
    expect(isInfraError(new Error('process exited with code 127'))).toBe(true);
  });

  it('flags spawn / auth / timeout / network failures', () => {
    expect(isInfraError(new Error('spawn codex ENOENT'))).toBe(true);
    expect(isInfraError(new Error('Request failed: 401 Unauthorized'))).toBe(true);
    expect(isInfraError(new Error('connect ETIMEDOUT'))).toBe(true);
    expect(isInfraError(new Error('read ECONNRESET'))).toBe(true);
    expect(isInfraError('getaddrinfo ENOTFOUND api.openai.com')).toBe(true);
  });

  it('does NOT flag genuine task/code failures', () => {
    expect(isInfraError(new Error('TypeError: cannot read property foo of undefined'))).toBe(false);
    expect(isInfraError(new Error('Test failed: expected 3 to equal 4'))).toBe(false);
    expect(isInfraError(new Error('old_string not found in file'))).toBe(false);
    expect(isInfraError(new Error('Reviewer rejected: missing null check'))).toBe(false);
  });

  it('handles non-Error inputs safely', () => {
    expect(isInfraError(undefined)).toBe(false);
    expect(isInfraError(null)).toBe(false);
    expect(isInfraError('')).toBe(false);
  });
});
