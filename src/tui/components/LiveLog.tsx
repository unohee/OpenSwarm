// LiveLog — recent daemon log lines (EPIC INT-1813 S5). Each line is syntax-
// highlighted via LogLine (stage/issue/worktree/code/level colors). (INT-1974)
import { Box, Text } from 'ink';
import { LogLine } from './LogLine.js';

export interface LiveLogProps {
  logs: string[];
  max?: number;
}

export function LiveLog({ logs, max = 12 }: LiveLogProps) {
  const shown = logs.slice(-max);
  return (
    <Box flexDirection="column">
      <Text bold>Live log</Text>
      {shown.length === 0 ? (
        <Text dimColor>(no log output yet)</Text>
      ) : (
        shown.map((line, i) => <LogLine key={i} line={line} />)
      )}
    </Box>
  );
}
