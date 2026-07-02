import { EventEmitter } from 'node:events';
import { afterEach, describe, it, expect, vi } from 'vitest';

const httpGetMock = vi.hoisted(() => vi.fn());

vi.mock('node:http', () => ({
  default: { get: httpGetMock },
}));

import { connectEventStream, eventStreamPath, parseSseFrames } from './sse.js';

afterEach(() => {
  httpGetMock.mockReset();
});

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

  it('uses skipReplay on reconnect paths to avoid replay duplicates', () => {
    expect(eventStreamPath(false)).toBe('/api/events');
    expect(eventStreamPath(true)).toBe('/api/events?skipReplay=1');
  });

  it('reconnects with skipReplay after an established stream ends', async () => {
    const paths: string[] = [];
    const responses: EventEmitter[] = [];
    httpGetMock.mockImplementation((options: { path: string }, callback: (res: EventEmitter & { setEncoding: () => void }) => void) => {
      paths.push(options.path);
      const res = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
      responses.push(res);
      callback(res);
      return Object.assign(new EventEmitter(), { destroy: vi.fn() });
    });

    const handle = connectEventStream({ port: 3847, onEvent: vi.fn(), reconnectMs: 1 });
    responses[0].emit('end');
    await new Promise((resolve) => setTimeout(resolve, 5));
    handle.close();

    expect(paths).toEqual(['/api/events', '/api/events?skipReplay=1']);
  });
});
