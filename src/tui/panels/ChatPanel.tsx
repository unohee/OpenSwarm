// ============================================
// OpenSwarm - Chat tab panel (EPIC INT-1813 S4 / INT-1937)
// Wires the pure chat model (chatModel.ts) to the input/log components and to
// chatSession.callChatModel (streaming). Network/effect boundary — the reducer,
// parser and presentational components carry the tested logic.
// ============================================

import { Box } from 'ink';
import { useReducer, useState, useCallback } from 'react';
import { chatReducer, initialChatState, parseInput, matchSlash, SLASH_COMMANDS, type ChatAction } from '../chatModel.js';
import { ChatLog } from '../components/ChatLog.js';
import { ChatInput } from '../components/ChatInput.js';
import { CommandPalette } from '../components/CommandPalette.js';
import { callChatModel, loadDefaultProvider } from '../../support/chatSession.js';
import { getDefaultChatModel } from '../../support/chatBackend.js';
import type { AdapterName } from '../../adapters/types.js';

export interface ChatPanelProps {
  active: boolean;
  provider?: string;
  model?: string;
}

function runLocalCommand(name: string, dispatch: (a: ChatAction) => void): void {
  switch (name) {
    case '/clear':
      dispatch({ type: 'clear' });
      break;
    case '/help':
      dispatch({ type: 'system', content: SLASH_COMMANDS.map((c) => `${c.name} ${c.args} — ${c.desc}`).join('\n') });
      break;
    case '/goal':
    case '/plan':
      dispatch({ type: 'system', content: `${name} dispatch lands in S8 (INT-1941) — use the dashboard/daemon for now.` });
      break;
    case '/model':
    case '/provider':
      dispatch({ type: 'system', content: `${name} switching from the Ink TUI lands in S8 (INT-1941).` });
      break;
    default:
      dispatch({ type: 'system', content: `Unknown command: ${name}` });
  }
}

export function ChatPanel({ active, provider: providerProp, model: modelProp }: ChatPanelProps) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const provider = (providerProp as AdapterName | undefined) ?? loadDefaultProvider();
  const model = modelProp ?? getDefaultChatModel(provider);

  const submit = useCallback(
    async (raw: string) => {
      const parsed = parseInput(raw);
      setInput('');
      if (!parsed) return;
      if (parsed.kind === 'command') {
        runLocalCommand(parsed.name, dispatch);
        return;
      }
      dispatch({ type: 'user', content: parsed.text });
      dispatch({ type: 'stream', chunk: '' });
      setBusy(true);
      try {
        await callChatModel(parsed.text, provider, model, (t) => dispatch({ type: 'stream', chunk: t }));
      } catch (e) {
        dispatch({ type: 'stream', chunk: `\n[error] ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        dispatch({ type: 'commit' });
        setBusy(false);
      }
    },
    [provider, model],
  );

  return (
    <Box flexDirection="column">
      <ChatLog history={state.history} streaming={state.streaming} />
      <ChatInput value={input} active={active} busy={busy} onChange={setInput} onSubmit={submit} />
      <CommandPalette matches={matchSlash(input)} />
    </Box>
  );
}
