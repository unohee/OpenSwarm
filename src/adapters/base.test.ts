import { describe, it, expect } from 'vitest';
import { extractStreamJsonError } from './base.js';

// The claude CLI (--output-format stream-json) exits non-zero with an empty
// stderr and reports the real failure in a stdout result event. (INT-2509)
describe('extractStreamJsonError', () => {
  it('extracts the error from a result event with is_error', () => {
    const stdout = [
      '{"type":"system","subtype":"init","cwd":"/tmp"}',
      '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Rate limit reached for the five_hour window"}',
    ].join('\n');
    expect(extractStreamJsonError(stdout)).toBe('Rate limit reached for the five_hour window');
  });

  it('falls back to the subtype when result text is missing', () => {
    const stdout = '{"type":"result","subtype":"error_max_turns","is_error":true}';
    expect(extractStreamJsonError(stdout)).toBe('error_max_turns');
  });

  it('returns empty for a successful run', () => {
    const stdout = [
      '{"type":"system","subtype":"init"}',
      '{"type":"result","subtype":"success","is_error":false,"result":"OK"}',
    ].join('\n');
    expect(extractStreamJsonError(stdout)).toBe('');
  });

  it('ignores non-JSON noise', () => {
    expect(extractStreamJsonError('plain text output\nno json here')).toBe('');
  });
});
