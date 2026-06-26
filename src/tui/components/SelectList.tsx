// SelectList — a titled, single-select list with a highlighted row. Used by the
// /provider and /model switchers (INT-1960/INT-1961). Key handling lives in the
// caller (ChatInput's palette routing); this is pure presentation.
import { Box, Text } from 'ink';

export function SelectList({
  title,
  items,
  selectedIndex = 0,
}: {
  title: string;
  items: string[];
  selectedIndex?: number;
}) {
  if (items.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow">{title}</Text>
      {items.map((item, i) => {
        const selected = i === selectedIndex;
        return (
          <Text key={item} inverse={selected}>
            {`${selected ? '❯ ' : '  '}${item}`}
          </Text>
        );
      })}
      <Text dimColor>{'  ↑/↓ select · Enter confirm · Esc cancel'}</Text>
    </Box>
  );
}
