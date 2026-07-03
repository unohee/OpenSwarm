// PipelinePanel — the Pipeline observability tab (EPIC INT-1813 S5 / INT-1938).
// Subscribes to the daemon SSE stream and shows the stage timeline + live log,
// the CLI counterpart of the web dashboard's PIPELINE tab.
import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { StageTimeline } from '../components/StageTimeline.js';
import { SubagentTree } from '../components/SubagentTree.js';
import { LiveLog } from '../components/LiveLog.js';
import { usePipelineEvents } from '../hooks/usePipelineEvents.js';
import { buildSubagentTree } from '../subagentTree.js';
import { theme } from '../theme.js';

export interface PipelinePanelProps {
  /** Daemon HTTP port; when unset the panel renders idle (no connection). */
  port?: number;
}

export function PipelinePanel({ port }: PipelinePanelProps) {
  const { stages, logs, connected } = usePipelineEvents(port);
  // Stabilize the tree identity so it only rebuilds when stages actually change
  // (log-only updates keep the same `stages` reference). Prevents SubagentTree's
  // spinner effect from re-subscribing every render + lets React.memo skip it. (INT-2407)
  const repositories = useMemo(() => buildSubagentTree(stages), [stages]);
  const live = !!port && connected;
  const label = !port
    ? ' daemon port unknown'
    : connected
    ? ` live (:${port})`
    : ` connecting :${port}…`;
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={live ? theme.ok : theme.dim}>{live ? '●' : '○'}</Text>
        <Text dimColor>{label}</Text>
      </Text>
      <SubagentTree repositories={repositories} />
      <Box marginTop={1}>
        <StageTimeline stages={stages} />
      </Box>
      <Box marginTop={1}>
        <LiveLog logs={logs} />
      </Box>
    </Box>
  );
}
