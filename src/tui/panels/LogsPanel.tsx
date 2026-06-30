// LogsPanel — the Logs tab: live daemon log stream (INT-1962). Reuses the SSE
// subscription (usePipelineEvents) and the LiveLog presenter; a fuller, timeline-
// free view of the same log lines the Pipeline tab shows.
import { Box, Text } from 'ink';
import { LiveLog } from '../components/LiveLog.js';
import { usePipelineEvents } from '../hooks/usePipelineEvents.js';
import { theme } from '../theme.js';

export interface LogsPanelProps {
  /** Daemon HTTP port; when unset the panel renders idle (no connection). */
  port?: number;
  /** Max log lines to show (default 30). */
  max?: number;
}

export function LogsPanel({ port, max = 30 }: LogsPanelProps) {
  const { logs, connected } = usePipelineEvents(port);
  const live = !!port && connected;
  const label = !port
    ? ' daemon port unknown — start the daemon to stream logs'
    : connected
      ? ` live (:${port})`
      : ` connecting :${port}…`;
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={live ? theme.ok : theme.dim}>{live ? '●' : '○'}</Text>
        <Text dimColor>{label}</Text>
      </Text>
      <Box marginTop={1}>
        <LiveLog logs={logs} max={max} />
      </Box>
    </Box>
  );
}
