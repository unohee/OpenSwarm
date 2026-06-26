// HelpBar — bottom keybinding hint strip (EPIC INT-1813 S3).
import { Box, Text } from 'ink';

export function HelpBar() {
  return (
    <Box>
      <Text dimColor>1-6 switch tab · Tab/Shift-Tab cycle · ←/→ move · q quit</Text>
    </Box>
  );
}
