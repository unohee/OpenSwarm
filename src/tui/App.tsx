// ============================================
// OpenSwarm - Ink TUI scaffold (EPIC INT-1813 S1 / INT-1934)
// Minimal Ink shell that proves the JSX build + render path end to end.
// The real 6-tab cockpit (App/StatusBar/TabBar + tabs) replaces this in
// S3 (INT-1936); kept deliberately tiny so S1 stays a pure build-chain change.
// ============================================

import { Box, Text } from 'ink';

export interface AppProps {
  /** Version string shown in the header (from package.json). */
  version?: string;
}

export function App({ version }: AppProps) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan" bold>OpenSwarm</Text>
      <Text dimColor>{version ? `v${version}` : 'Ink TUI scaffold'}</Text>
    </Box>
  );
}
