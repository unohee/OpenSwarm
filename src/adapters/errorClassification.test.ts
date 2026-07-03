import { describe, it, expect } from 'vitest';
import { isInfraError, codexMcpAuthHint } from './errorClassification.js';

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
    expect(isInfraError(new Error('codex timeout after 300000ms'))).toBe(true);
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

describe('codexMcpAuthHint (INT-2408)', () => {
  it('returns a hint for the real codex rmcp AuthRequired transport failure', () => {
    const err = new Error(
      'codex CLI failed with code 1: rmcp::transport::worker: worker quit with fatal: ' +
        'Transport channel closed, when AuthRequired',
    );
    const hint = codexMcpAuthHint(err);
    expect(hint).toContain('~/.codex/config.toml');
    expect(hint).toContain('401');
    expect(hint).toContain("url=");
  });

  it('matches the bare "Transport channel closed ... AuthRequired" stderr text too', () => {
    expect(codexMcpAuthHint('Transport channel closed, when AuthRequired')).not.toBeNull();
  });

  it('requires BOTH an AuthRequired signal and an rmcp/transport marker', () => {
    // rmcp marker but no AuthRequired -> not our case
    expect(codexMcpAuthHint('rmcp::transport::worker: worker quit with fatal: EOF')).toBeNull();
    // AuthRequired but no rmcp/transport marker -> not our case
    expect(codexMcpAuthHint('AuthRequired: token expired')).toBeNull();
    // generic 401 with neither marker
    expect(codexMcpAuthHint('Request failed: 401 Unauthorized')).toBeNull();
  });

  it('returns null for unrelated and empty inputs', () => {
    expect(codexMcpAuthHint(new Error('TypeError: cannot read property foo of undefined'))).toBeNull();
    expect(codexMcpAuthHint(undefined)).toBeNull();
    expect(codexMcpAuthHint(null)).toBeNull();
    expect(codexMcpAuthHint('')).toBeNull();
  });
});
