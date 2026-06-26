// HelpBar — bottom hint strip (INT-1943). Slash commands + nav, themed dim.
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export function HelpBar() {
  return (
    <Box>
      <Text color={theme.accent}>/plan /goal /model</Text>
      <Text color={theme.dim}>{'   ·   Tab: panels   ·   ↑↓ history   ·   ^C quit'}</Text>
    </Box>
  );
}
