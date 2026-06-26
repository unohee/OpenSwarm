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
import { useTerminalSize } from './hooks/useTerminalSize.js';

export interface AppProps {
  version?: string;
  provider?: string;
  model?: string;
  /** Initial active tab index (deep-link / tests). Defaults to Chat. */
  initialTab?: number;
}

export function App({ version, provider, model, initialTab = 0 }: AppProps) {
  const [active, setActive] = useState(initialTab);
  const { columns, rows } = useTerminalSize();
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === 'q') return exit();
    if (key.tab) return setActive((a) => nextTab(a, key.shift ? -1 : +1));
    if (key.leftArrow) return setActive((a) => nextTab(a, -1));
    if (key.rightArrow) return setActive((a) => nextTab(a, +1));
    const digit = tabFromDigit(input);
    if (digit !== null) setActive(digit);
  });

  const activeTab = TABS[active];

  return (
    <Box flexDirection="column" width={columns}>
      <StatusBar version={version} provider={provider} model={model} />
      <TabBar active={active} />
      <Box flexDirection="column" paddingY={1} minHeight={Math.max(1, rows - 4)}>
        <Text>{`${activeTab.label} — panel arrives in a later sub-issue (S4–S6).`}</Text>
      </Box>
      <HelpBar />
    </Box>
  );
}
