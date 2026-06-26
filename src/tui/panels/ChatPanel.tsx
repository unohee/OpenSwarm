// ============================================
// OpenSwarm - Chat tab panel (EPIC INT-1813 S4 + S8 / INT-1937, INT-1941)
// Wires the pure chat model to the input/log components and to
// chatSession.callChatModel (streaming). S8 adds /plan + /goal orchestration via
// planCommand.runPlanCommand, with confirms routed through a pending-input flow
// (the Ink PlanIO implementation). Network/effect boundary.
// ============================================

import { Box } from 'ink';
import { useReducer, useState, useCallback } from 'react';
import {
  chatReducer,
  initialChatState,
  parseInput,
  matchSlash,
  movePaletteSelection,
  normalizeConfirm,
  isActivityNoise,
  SLASH_COMMANDS,
} from '../chatModel.js';
import { ChatLog } from '../components/ChatLog.js';
import { ChatInput } from '../components/ChatInput.js';
import { CommandPalette } from '../components/CommandPalette.js';
import { SelectList } from '../components/SelectList.js';
import { listAdapterNames } from '../../adapters/index.js';
import { callChatModel, loadDefaultProvider } from '../../support/chatSession.js';
import { getDefaultChatModel, listChatModels } from '../../support/chatBackend.js';
import { runPlanCommand, type PlanIO } from '../../support/planCommand.js';
import { runGoalCommand, buildGoalPursuitPrompt, GOAL_PURSUIT_MAX_TURNS } from '../../support/goalCommand.js';
import type { AdapterName } from '../../adapters/types.js';

export interface ChatPanelProps {
  active: boolean;
  provider?: string;
  model?: string;
  /** Project root for /plan + /goal dispatch (defaults to cwd). */
  projectPath?: string;
}

export function ChatPanel({ active, provider: providerProp, model: modelProp, projectPath }: ChatPanelProps) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [input, setInput] = useState('');
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string[]>([]);
  // When set, the next submitted line is routed here (a /plan confirm or edit)
  // instead of being treated as chat — the Ink analogue of blessed pendingInput.
  const [pending, setPending] = useState<{ resolve: (value: string) => void } | null>(null);

  // provider/model are runtime-switchable via /provider and /model (INT-1960/1961).
  const [provider, setProvider] = useState<AdapterName>((providerProp as AdapterName | undefined) ?? loadDefaultProvider());
  const [model, setModel] = useState<string>(modelProp ?? getDefaultChatModel((providerProp as AdapterName | undefined) ?? loadDefaultProvider()));
  // Active /provider | /model selector overlay (null = none). (INT-1960/1961)
  const [selector, setSelector] = useState<{ kind: 'provider' | 'model'; title: string; items: string[] } | null>(null);
  const [selectorIndex, setSelectorIndex] = useState(0);
  const cwd = projectPath ?? process.cwd();

  const ask = useCallback(
    (prompt: string) =>
      new Promise<string>((resolve) => {
        dispatch({ type: 'system', content: prompt });
        setPending({ resolve });
      }),
    [],
  );

  const planIO: PlanIO = {
    print: (line) => dispatch({ type: 'system', content: line }),
    confirm: async (prompt) => normalizeConfirm(await ask(prompt)),
    promptText: (prompt) => ask(prompt),
  };

  const runPlan = useCallback(
    async (goal: string) => {
      setBusy(true);
      try {
        await runPlanCommand(goal, planIO, { projectPath: cwd, model });
      } catch (e) {
        dispatch({ type: 'system', content: `✖ plan failed: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        setBusy(false);
      }
    },
    // planIO is rebuilt each render but only closes over stable dispatch/ask.
    [cwd, model], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Stream an agentic chat turn into the reducer. Shared by free chat and simple
  // /goal pursuit (the latter raises maxTurns). (INT-1821)
  const streamChat = useCallback(
    async (prompt: string, maxTurns?: number) => {
      dispatch({ type: 'stream', chunk: '' });
      setActivity([]);
      setBusy(true);
      try {
        await callChatModel(
          prompt,
          provider,
          model,
          (t) => dispatch({ type: 'stream', chunk: t }),
          (line) => {
            if (isActivityNoise(line)) return;
            setActivity((a) => [...a, line].slice(-10));
          },
          maxTurns,
        );
      } catch (e) {
        dispatch({ type: 'stream', chunk: `\n[error] ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        dispatch({ type: 'commit' });
        setActivity([]);
        setBusy(false);
      }
    },
    [provider, model],
  );

  // /goal routes by complexity: simple → pursue in-session (streamed), complex →
  // decompose & dispatch via the /plan flow. (INT-1821 / S8)
  const runGoal = useCallback(
    async (goal: string) => {
      setBusy(true);
      try {
        await runGoalCommand(
          goal,
          planIO,
          { projectPath: cwd, model, provider },
          { pursue: (g) => streamChat(buildGoalPursuitPrompt(g), GOAL_PURSUIT_MAX_TURNS) },
        );
      } catch (e) {
        dispatch({ type: 'system', content: `✖ goal failed: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        setBusy(false);
      }
    },
    [cwd, model, provider, streamChat], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Open the /model selector for the current provider (async catalog). (INT-1961)
  const openModelSelector = useCallback(async () => {
    dispatch({ type: 'system', content: `Fetching models for ${provider}…` });
    try {
      const models = await listChatModels(provider);
      if (!models.length) {
        dispatch({ type: 'system', content: `No models listed for ${provider}. Use /model <name>.` });
        return;
      }
      setSelectorIndex(Math.max(0, models.indexOf(model)));
      setSelector({ kind: 'model', title: `Switch model (${provider}):`, items: models });
    } catch (e) {
      dispatch({ type: 'system', content: `✖ failed to list models: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, [provider, model]);

  const runCommand = useCallback(
    (name: string, args: string) => {
      switch (name) {
        case '/clear':
          dispatch({ type: 'clear' });
          break;
        case '/help':
          dispatch({ type: 'system', content: SLASH_COMMANDS.map((c) => `${c.name} ${c.args} — ${c.desc}`).join('\n') });
          break;
        case '/plan':
          void runPlan(args);
          break;
        case '/goal':
          // /goal routes by complexity (INT-1821): simple → pursue in-session,
          // complex → decompose & dispatch. Shared, UI-agnostic goalCommand.
          void runGoal(args);
          break;
        case '/provider': {
          // `/provider <name>` switches directly; bare `/provider` opens a selector. (INT-1960)
          const items = listAdapterNames();
          const target = args.trim();
          if (target) {
            if (!items.includes(target as AdapterName)) {
              dispatch({ type: 'system', content: `Unknown provider "${target}". Options: ${items.join(', ')}` });
            } else {
              setProvider(target as AdapterName);
              setModel(getDefaultChatModel(target as AdapterName));
              dispatch({ type: 'system', content: `Provider → ${target} (model: ${getDefaultChatModel(target as AdapterName)})` });
            }
            break;
          }
          setSelectorIndex(Math.max(0, items.indexOf(provider)));
          setSelector({ kind: 'provider', title: 'Switch provider:', items });
          break;
        }
        case '/model': {
          // `/model <name>` switches directly; bare `/model` opens an async selector. (INT-1961)
          const target = args.trim();
          if (target) {
            setModel(target);
            dispatch({ type: 'system', content: `Model → ${target}` });
            break;
          }
          void openModelSelector();
          break;
        }
        default:
          dispatch({ type: 'system', content: `Unknown command: ${name}` });
      }
    },
    [runPlan, runGoal, provider, openModelSelector],
  );

  // Apply the highlighted choice in the /provider | /model selector. (INT-1960/1961)
  const applySelector = useCallback(() => {
    if (!selector) return;
    const choice = selector.items[selectorIndex];
    if (choice) {
      if (selector.kind === 'provider') {
        setProvider(choice as AdapterName);
        setModel(getDefaultChatModel(choice as AdapterName));
        dispatch({ type: 'system', content: `Provider → ${choice} (model: ${getDefaultChatModel(choice as AdapterName)})` });
      } else {
        setModel(choice);
        dispatch({ type: 'system', content: `Model → ${choice}` });
      }
    }
    setSelector(null);
    setSelectorIndex(0);
  }, [selector, selectorIndex]);

  const submit = useCallback(
    async (raw: string) => {
      setInput('');
      // A pending /plan confirm/edit consumes the next line verbatim.
      if (pending) {
        const { resolve } = pending;
        setPending(null);
        resolve(raw);
        return;
      }
      const parsed = parseInput(raw);
      if (!parsed) return;
      if (parsed.kind === 'command') {
        runCommand(parsed.name, parsed.args);
        return;
      }
      dispatch({ type: 'user', content: parsed.text });
      await streamChat(parsed.text);
    },
    [pending, runCommand, streamChat],
  );

  // While a /plan confirm is pending, keep the field active even though busy.
  const inputActive = active && (!busy || pending !== null);

  // Interactive command palette (INT-1959): ↑/↓ select, Enter/Tab complete.
  // A /provider|/model selector (INT-1960/1961) takes precedence when open.
  const matches = matchSlash(input);
  const selectorOpen = inputActive && selector !== null;
  const slashOpen = inputActive && pending === null && selector === null && matches.length > 0;
  const menuOpen = selectorOpen || slashOpen;
  const handleChange = useCallback((v: string) => {
    setInput(v);
    setPaletteIndex(0);
  }, []);
  const onSlashSelect = useCallback(() => {
    const cmd = matches[paletteIndex];
    if (!cmd) return;
    if (cmd.args) {
      // command takes args → complete to "name " so the user can type them
      setInput(`${cmd.name} `);
      setPaletteIndex(0);
    } else {
      setInput('');
      runCommand(cmd.name, '');
    }
  }, [matches, paletteIndex, runCommand]);

  return (
    <Box flexDirection="column">
      <ChatLog history={state.history} streaming={state.streaming} activity={activity} busy={busy && pending === null} />
      <ChatInput
        value={input}
        active={inputActive}
        busy={busy && pending === null}
        onChange={handleChange}
        onSubmit={submit}
        paletteOpen={menuOpen}
        onPaletteMove={(delta) =>
          selectorOpen
            ? setSelectorIndex((i) => movePaletteSelection(i, delta, selector!.items.length))
            : setPaletteIndex((i) => movePaletteSelection(i, delta, matches.length))
        }
        onPaletteSelect={() => (selectorOpen ? applySelector() : onSlashSelect())}
        onPaletteClose={() => {
          if (selectorOpen) {
            setSelector(null);
            setSelectorIndex(0);
          } else {
            setInput('');
          }
        }}
      />
      {selectorOpen ? (
        <SelectList title={selector!.title} items={selector!.items} selectedIndex={selectorIndex} />
      ) : (
        <CommandPalette matches={matches} selectedIndex={paletteIndex} />
      )}
    </Box>
  );
}
