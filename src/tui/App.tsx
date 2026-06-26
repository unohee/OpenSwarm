// ============================================
// OpenSwarm - Ink TUI shell (EPIC INT-1813 S3 / INT-1936)
// App composes the cockpit chrome (StatusBar / TabBar / HelpBar) around the
// active tab panel and owns tab navigation (number keys, Tab/Shift-Tab, arrows,
// q to quit). Tab panels are placeholders here — the real Chat (S4), Pipeline/
// SSE (S5) and monitor (S6) panels slot into the content area next.
// ============================================

import { Box, Text, useInput, useApp } from 'ink';
import { useState } from 'react';
import { TABS, nextTab, tabFromDigit } from './tabs.js';
import { StatusBar } from './components/StatusBar.js';
import { TabBar } from './components/TabBar.js';
import { HelpBar } from './components/HelpBar.js';
import { PipelinePanel } from './panels/PipelinePanel.js';
import { ChatPanel } from './panels/ChatPanel.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';

export interface AppProps {
  version?: string;
  provider?: string;
  model?: string;
  /** Daemon HTTP port — used by the Pipeline tab's SSE connection. */
  port?: number;
  /** Initial active tab index (deep-link / tests). Defaults to Chat. */
  initialTab?: number;
}

export function App({ version, provider, model, port, initialTab = 0 }: AppProps) {
  const [active, setActive] = useState(initialTab);
  const { columns, rows } = useTerminalSize();
  const { exit } = useApp();

  const activeTab = TABS[active];
  const chatActive = activeTab.id === 'chat';

  useInput((input, key) => {
    // Tab always cycles — the way to leave the chat input.
    if (key.tab) return setActive((a) => nextTab(a, key.shift ? -1 : +1));
    // On the Chat tab the input field owns every other key (incl. digits/q).
    if (chatActive) return;
    if (input === 'q') return exit();
    if (key.leftArrow) return setActive((a) => nextTab(a, -1));
    if (key.rightArrow) return setActive((a) => nextTab(a, +1));
    const digit = tabFromDigit(input);
    if (digit !== null) setActive(digit);
  });

  return (
    <Box flexDirection="column" width={columns}>
      <StatusBar version={version} provider={provider} model={model} />
      <TabBar active={active} />
      <Box flexDirection="column" paddingY={1} minHeight={Math.max(1, rows - 4)}>
        {activeTab.id === 'chat' ? (
          <ChatPanel active={chatActive} provider={provider} model={model} />
        ) : activeTab.id === 'pipeline' ? (
          <PipelinePanel port={port} />
        ) : (
          <Text>{`${activeTab.label} — panel arrives in a later sub-issue (S6).`}</Text>
        )}
      </Box>
      <HelpBar />
    </Box>
  );
}
