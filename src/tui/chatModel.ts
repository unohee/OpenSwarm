// ============================================
// OpenSwarm - Chat model (EPIC INT-1813 S4 / INT-1937)
// Pure chat state + input parsing for the Ink Chat tab. No React/ink/network —
// the streaming reducer and slash parser are unit-tested; ChatPanel wires them
// to chatSession.callChatModel.
// ============================================

export interface ChatLine {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatState {
  /** Finalized lines — rendered in <Static> (no re-render, no flicker). */
  history: ChatLine[];
  /** In-flight assistant text being streamed, or null when idle. */
  streaming: string | null;
}

export const initialChatState: ChatState = { history: [], streaming: null };

export type ChatAction =
  | { type: 'user'; content: string }
  | { type: 'system'; content: string }
  | { type: 'stream'; chunk: string }
  | { type: 'commit' }
  | { type: 'clear' };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'user':
      return { ...state, history: [...state.history, { role: 'user', content: action.content }] };
    case 'system':
      return { ...state, history: [...state.history, { role: 'system', content: action.content }] };
    case 'stream':
      return { ...state, streaming: (state.streaming ?? '') + action.chunk };
    case 'commit':
      return state.streaming === null
        ? state
        : { history: [...state.history, { role: 'assistant', content: state.streaming }], streaming: null };
    case 'clear':
      return initialChatState;
  }
}

export interface SlashCommand {
  name: string;
  args: string;
  desc: string;
}

/** Slash commands offered in the Ink palette (mirrors the blessed TUI). */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: '/goal', args: '<goal>', desc: 'Set a goal & pursue it autonomously' },
  { name: '/plan', args: '<goal>', desc: 'Decompose a goal & dispatch to the loop' },
  { name: '/model', args: '[name]', desc: 'Switch model' },
  { name: '/provider', args: '[name]', desc: 'Switch provider' },
  { name: '/clear', args: '', desc: 'Clear the conversation' },
  { name: '/help', args: '', desc: 'Show all commands' },
];

export type ParsedInput =
  | { kind: 'chat'; text: string }
  | { kind: 'command'; name: string; args: string };

/** Classify a submitted input line as free chat or a slash command. */
export function parseInput(raw: string): ParsedInput | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith('/')) {
    const sp = t.indexOf(' ');
    return sp === -1
      ? { kind: 'command', name: t, args: '' }
      : { kind: 'command', name: t.slice(0, sp), args: t.slice(sp + 1).trim() };
  }
  return { kind: 'chat', text: t };
}

/** Slash commands whose name prefix-matches the current input (palette). */
export function matchSlash(input: string): SlashCommand[] {
  if (!input.startsWith('/') || input.includes(' ')) return [];
  const q = input.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.slice(1).toLowerCase().startsWith(q));
}
