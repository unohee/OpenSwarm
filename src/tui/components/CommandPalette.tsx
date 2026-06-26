// CommandPalette — slash-command suggestions for the current input (S4).
// Interactive: the selected row (↑/↓) is highlighted; Enter/Tab completes it. (INT-1959)
import { Box, Text } from 'ink';
import type { SlashCommand } from '../chatModel.js';

export function CommandPalette({ matches, selectedIndex = 0 }: { matches: SlashCommand[]; selectedIndex?: number }) {
  if (matches.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {matches.map((c, i) => {
        const selected = i === selectedIndex;
        return (
          <Text key={c.name} inverse={selected}>
            <Text color="cyan">{`${selected ? '❯ ' : '  '}${c.name}`}</Text>
            {c.args ? <Text dimColor>{` ${c.args}`}</Text> : null}
            <Text dimColor>{`  ${c.desc}`}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
