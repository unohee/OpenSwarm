// CommandPalette — slash-command suggestions for the current input (S4).
import { Box, Text } from 'ink';
import type { SlashCommand } from '../chatModel.js';

export function CommandPalette({ matches }: { matches: SlashCommand[] }) {
  if (matches.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {matches.map((c) => (
        <Text key={c.name}>
          <Text color="cyan">{c.name}</Text>
          {c.args ? <Text dimColor>{` ${c.args}`}</Text> : null}
          <Text dimColor>{`  ${c.desc}`}</Text>
        </Text>
      ))}
    </Box>
  );
}
