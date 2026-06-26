// ============================================
// OpenSwarm - Ink TUI shell (EPIC INT-1813 S3 / INT-1936)
// App composes the cockpit chrome (ContextBar / TabBar / HelpBar) around the
// active tab panel and owns tab navigation (number keys, Tab/Shift-Tab, arrows,
// q to quit). Tab panels are placeholders here — the real Chat (S4), Pipeline/
// SSE (S5) and monitor (S6) panels slot into the content area next.
// ============================================

import { Box, Text, useInput, useApp } from 'ink';
import { useState } from 'react';
import { TABS, nextTab, tabFromDigit } from './tabs.js';
import { ContextBar } from './components/ContextBar.js';
import { TabBar } from './components/TabBar.js';
import { HelpBar } from './components/HelpBar.js';
import { PipelinePanel } from './panels/PipelinePanel.js';
import { ChatPanel } from './panels/ChatPanel.js';
import { MonitorPanel } from './panels/MonitorPanel.js';
import { LogsPanel } from './panels/LogsPanel.js';
import { fetchProjects, fetchTasks, fetchStuck, fetchIssues } from './monitorApi.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';

const MONITOR_FETCHERS = {
  projects: fetchProjects,
  tasks: fetchTasks,
  stuck: fetchStuck,
  issues: fetchIssues,
} as const;

export interface AppProps {
  version?: string;
  provider?: string;
  model?: string;
  /** Daemon HTTP port — used by the Pipeline tab's SSE connection. */
  port?: number;
  /** Project root (shown in the context bar). */
  cwd?: string;
  /** Git branch (shown in the context bar). */
  branch?: string;
  /** Initial active tab index (deep-link / tests). Defaults to Chat. */
  initialTab?: number;
}

export function App({ version, provider, model, port, cwd, branch, initialTab = 0 }: AppProps) {
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
      <ContextBar version={version} provider={provider} model={model} cwd={cwd} branch={branch} />
      <TabBar active={active} />
      <Box flexDirection="column" paddingY={1} minHeight={Math.max(1, rows - 4)}>
        {activeTab.id === 'chat' ? (
          <ChatPanel active={chatActive} provider={provider} model={model} />
        ) : activeTab.id === 'pipeline' ? (
          <PipelinePanel port={port} />
        ) : activeTab.id === 'logs' ? (
          <LogsPanel port={port} />
        ) : activeTab.id in MONITOR_FETCHERS ? (
          <MonitorPanel port={port} fetcher={MONITOR_FETCHERS[activeTab.id as keyof typeof MONITOR_FETCHERS]} />
        ) : (
          <Text>{`${activeTab.label} — not yet implemented.`}</Text>
        )}
      </Box>
      <HelpBar />
    </Box>
  );
}
