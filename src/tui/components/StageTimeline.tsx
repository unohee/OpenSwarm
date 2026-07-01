// StageTimeline — pipeline:stage events as a timeline (EPIC INT-1813 S5).
// Presentational: takes already-reduced stage entries (parity with the
// dashboard's renderStages).
import { Box, Text } from 'ink';
import { STATUS } from '../theme.js';
import type { StatusKind } from '../../support/glyphs.js';
import type { StageEntry } from '../pipelineEvents.js';

// Single-sourced glyphs + colors (INT-2260): running → ◐, complete → ✓, fail → ✗.
const KIND: Record<StageEntry['status'], StatusKind> = { start: 'running', complete: 'ok', fail: 'err' };

export interface StageTimelineProps {
  stages: StageEntry[];
  max?: number;
}

export function StageTimeline({ stages, max = 12 }: StageTimelineProps) {
  const shown = stages.slice(-max);
  return (
    <Box flexDirection="column">
      <Text bold>Pipeline stages</Text>
      {shown.length === 0 ? (
        <Text dimColor>(no stage activity yet)</Text>
      ) : (
        shown.map((s, i) => {
          const dur = s.durationMs ? ` ${Math.round(s.durationMs / 1000)}s` : '';
          const model = s.model ? ` (${s.model})` : '';
          const decision = s.decision ? ` → ${s.decision}` : '';
          const st = STATUS[KIND[s.status]];
          return (
            <Text key={i} color={st.color}>
              {`${st.icon} ${s.stage}${model}${dur}${decision}`}
            </Text>
          );
        })
      )}
    </Box>
  );
}
