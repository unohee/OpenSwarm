// LiveLog — recent daemon log lines (EPIC INT-1813 S5). Presentational; parity
// with the dashboard's renderLog.
import { Box, Text } from 'ink';

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
        shown.map((line, i) => (
          <Text key={i} dimColor>{line}</Text>
        ))
      )}
    </Box>
  );
}
