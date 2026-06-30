// SubagentTree — concurrent tasks as a per-worktree agent tree (S7).
// Presentational: takes nodes built by buildSubagentTree.
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { TaskNode, TaskStatus } from '../subagentTree.js';

const ICON: Record<TaskStatus, string> = { start: '◐', complete: '●', fail: '✗' };
const COLOR: Record<TaskStatus, string> = { start: theme.running, complete: theme.ok, fail: theme.err };

export interface SubagentTreeProps {
  tasks: TaskNode[];
  /** Max tasks shown (most recent). */
  max?: number;
  /** Max stage children shown per task. */
  maxStages?: number;
}

export function SubagentTree({ tasks, max = 6, maxStages = 5 }: SubagentTreeProps) {
  const shown = tasks.slice(-max);
  return (
    <Box flexDirection="column">
      <Text bold>Agents (by task)</Text>
      {shown.length === 0 ? (
        <Text dimColor>(no active agents)</Text>
      ) : (
        shown.map((task) => (
          <Box key={task.taskId} flexDirection="column">
            <Text color={COLOR[task.status]}>{`${ICON[task.status]} ${task.taskId.slice(0, 16)}`}</Text>
            {task.stages.slice(-maxStages).map((s, i) => (
              <Text key={i} dimColor>
                {`   └ ${s.stage}${s.model ? ` (${s.model})` : ''} — ${s.status}`}
              </Text>
            ))}
          </Box>
        ))
      )}
    </Box>
  );
}
