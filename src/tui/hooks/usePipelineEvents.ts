// ============================================
// OpenSwarm - usePipelineEvents (EPIC INT-1813 S5 / INT-1938)
// Connects to the daemon SSE stream and reduces events into pipeline state.
// Network/effect boundary — the pure reducer (pipelineEvents.ts) and parser
// (sse.ts parseSseFrames) carry the tested logic.
// ============================================

import { useEffect, useReducer, useState } from 'react';
import { connectEventStream } from '../sse.js';
import { reducePipelineEvent, initialPipelineState, type PipelineState } from '../pipelineEvents.js';

export interface PipelineEventsResult extends PipelineState {
  connected: boolean;
}

export function usePipelineEvents(port: number | undefined): PipelineEventsResult {
  const [state, dispatch] = useReducer(reducePipelineEvent, initialPipelineState);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!port) return;
    const handle = connectEventStream({ port, onEvent: dispatch, onStatus: setConnected });
    return () => handle.close();
  }, [port]);

  return { ...state, connected };
}
