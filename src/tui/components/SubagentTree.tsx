// SubagentTree — concurrent tasks as a per-worktree agent tree (S7).
// Presentational: takes nodes built by buildSubagentTree.
import { Box, Text } from 'ink';
import { STATUS } from '../theme.js';
import type { StatusKind } from '../../support/glyphs.js';
import type { TaskNode, TaskStatus } from '../subagentTree.js';

// Single-sourced glyphs + colors (INT-2260): running → ◐, complete → ✓, fail → ✗.
const KIND: Record<TaskStatus, StatusKind> = { start: 'running', complete: 'ok', fail: 'err' };

// eslint-disable-next-line no-control-regex
const TERMINAL_ESCAPE_RE = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

function sanitizeTerminalLabel(value: string | undefined): string {
  return (value || '').replace(TERMINAL_ESCAPE_RE, '').replace(CONTROL_RE, '');
}

function clampLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export interface SubagentTreeProps {
  tasks: TaskNode[];
  /** Max tasks shown (most recent). */
  max?: number;
  /** Max stage children shown per task. */
  maxStages?: number;
}

export function SubagentTree({ tasks, max = 6, maxStages = 5 }: SubagentTreeProps) {
  const taskLimit = clampLimit(max);
  const stageLimit = clampLimit(maxStages);
  const shown = taskLimit === 0 ? [] : tasks.slice(-taskLimit);
  return (
    <Box flexDirection="column">
      <Text bold>Agents (by task)</Text>
      {shown.length === 0 ? (
        <Text dimColor>(no active agents)</Text>
      ) : (
        shown.map((task) => (
          <Box key={task.taskId} flexDirection="column">
            <Text color={STATUS[KIND[task.status]].color}>{`${STATUS[KIND[task.status]].icon} ${sanitizeTerminalLabel(task.taskId).slice(0, 16)}`}</Text>
            {(stageLimit === 0 ? [] : task.stages.slice(-stageLimit)).map((s, i) => (
              <Text key={i} dimColor>
                {`   └ ${sanitizeTerminalLabel(s.stage)}${s.model ? ` (${sanitizeTerminalLabel(s.model)})` : ''} — ${s.status}`}
              </Text>
            ))}
          </Box>
        ))
      )}
    </Box>
  );
}
