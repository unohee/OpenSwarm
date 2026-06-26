import { describe, it, expect } from 'vitest';
import { parseSseFrames } from './sse.js';

describe('parseSseFrames (EPIC INT-1813 S5)', () => {
  it('parses complete frames and returns the incomplete tail', () => {
    const buf =
      'data: {"type":"heartbeat"}\n\n' +
      'data: {"type":"log","data":{"taskId":"t","stage":"s","line":"hi"}}\n\n' +
      'data: {"type":"hea';
    const { events, rest } = parseSseFrames(buf);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('heartbeat');
    expect(events[1].type).toBe('log');
    expect(rest).toBe('data: {"type":"hea');
  });

  it('skips a malformed frame without throwing', () => {
    const { events } = parseSseFrames('data: not json\n\ndata: {"type":"heartbeat"}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('heartbeat');
  });

  it('ignores non-data lines (SSE comments / keepalive)', () => {
    const { events, rest } = parseSseFrames(': keepalive\n\ndata: {"type":"heartbeat"}\n\n');
    expect(events).toHaveLength(1);
    expect(rest).toBe('');
  });
});
