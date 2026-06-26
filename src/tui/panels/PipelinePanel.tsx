// PipelinePanel — the Pipeline observability tab (EPIC INT-1813 S5 / INT-1938).
// Subscribes to the daemon SSE stream and shows the stage timeline + live log,
// the CLI counterpart of the web dashboard's PIPELINE tab.
import { Box, Text } from 'ink';
import { StageTimeline } from '../components/StageTimeline.js';
import { SubagentTree } from '../components/SubagentTree.js';
import { LiveLog } from '../components/LiveLog.js';
import { usePipelineEvents } from '../hooks/usePipelineEvents.js';
import { buildSubagentTree } from '../subagentTree.js';

export interface PipelinePanelProps {
  /** Daemon HTTP port; when unset the panel renders idle (no connection). */
  port?: number;
}

export function PipelinePanel({ port }: PipelinePanelProps) {
  const { stages, logs, connected } = usePipelineEvents(port);
  const status = !port
    ? '○ daemon port unknown'
    : connected
    ? `● live (:${port})`
    : `○ connecting :${port}…`;
  return (
    <Box flexDirection="column">
      <Text dimColor>{status}</Text>
      <SubagentTree tasks={buildSubagentTree(stages)} />
      <Box marginTop={1}>
        <StageTimeline stages={stages} />
      </Box>
      <Box marginTop={1}>
        <LiveLog logs={logs} />
      </Box>
    </Box>
  );
}
