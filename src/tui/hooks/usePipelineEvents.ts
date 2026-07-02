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

type PipelineAction = Parameters<typeof reducePipelineEvent>[1] | { type: 'reset' };

function pipelineReducer(state: PipelineState, action: PipelineAction): PipelineState {
  if (action.type === 'reset') return initialPipelineState;
  return reducePipelineEvent(state, action);
}

export function usePipelineEvents(port: number | undefined): PipelineEventsResult {
  const [state, dispatch] = useReducer(pipelineReducer, initialPipelineState);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    dispatch({ type: 'reset' });
    setConnected(false);
    if (!port) return;
    const handle = connectEventStream({ port, onEvent: dispatch, onStatus: setConnected });
    return () => {
      setConnected(false);
      handle.close();
    };
  }, [port]);

  return { ...state, connected };
}
