// ============================================
// OpenSwarm - SSE client for the daemon event stream (EPIC INT-1813 S5)
// parseSseFrames is pure (unit-tested); connectEventStream is the network
// boundary that GETs /api/events and feeds parsed HubEvents to a callback,
// replacing the old 5-second poll in the TUI.
// ============================================

import http from 'node:http';
import type { HubEvent } from '../core/eventHub.js';

/**
 * Parse accumulated SSE text into events + the leftover (incomplete) tail.
 * Wire format (eventHub): `data: <json>\n\n` per event. Malformed frames are
 * skipped rather than throwing, so one bad frame can't kill the stream.
 */
export function parseSseFrames(buffer: string): { events: HubEvent[]; rest: string } {
  const events: HubEvent[] = [];
  let rest = buffer;
  let idx: number;
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    for (const line of frame.split('\n')) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('data:')) continue;
      const json = trimmed.slice(5).trim();
      if (!json) continue;
      try {
        events.push(JSON.parse(json) as HubEvent);
      } catch {
        // skip a malformed frame
      }
    }
  }
  return { events, rest };
}

export interface EventStreamHandle {
  close: () => void;
}

export interface EventStreamOptions {
  port: number;
  host?: string;
  onEvent: (event: HubEvent) => void;
  onStatus?: (connected: boolean) => void;
  /** Reconnect delay in ms after a drop/error (default 2000). */
  reconnectMs?: number;
}

export function eventStreamPath(skipReplay: boolean): string {
  return skipReplay ? '/api/events?skipReplay=1' : '/api/events';
}

/** Subscribe to the daemon's /api/events SSE stream, auto-reconnecting on drop. */
export function connectEventStream(opts: EventStreamOptions): EventStreamHandle {
  const host = opts.host ?? '127.0.0.1';
  const reconnectMs = opts.reconnectMs ?? 2000;
  let buffer = '';
  let closed = false;
  let connectedOnce = false;
  let req: http.ClientRequest | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReconnect = () => {
    opts.onStatus?.(false);
    if (closed) return;
    timer = setTimeout(connect, reconnectMs);
  };

  function connect() {
    if (closed) return;
    req = http.get(
      { host, port: opts.port, path: eventStreamPath(connectedOnce), headers: { Accept: 'text/event-stream' } },
      (res) => {
        connectedOnce = true;
        opts.onStatus?.(true);
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const { events, rest } = parseSseFrames(buffer);
          buffer = rest;
          for (const e of events) opts.onEvent(e);
        });
        res.on('end', scheduleReconnect);
      },
    );
    req.on('error', scheduleReconnect);
  }

  connect();

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      req?.destroy();
    },
  };
}
