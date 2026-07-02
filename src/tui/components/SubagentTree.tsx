// SubagentTree — concurrent tasks as a per-worktree agent tree (S7).
// Presentational: takes nodes built by buildSubagentTree.
import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { STATUS } from '../theme.js';
import type { StatusKind } from '../../support/glyphs.js';
import type { RepositoryNode, TaskStatus } from '../subagentTree.js';
import { spinnerFrame } from '../loadingMessages.js';

// Single-sourced glyphs + colors (INT-2260): running → ◐, complete → ✓, fail → ✗.
const KIND: Record<TaskStatus, StatusKind> = { start: 'running', complete: 'ok', fail: 'err' };
const STAGE_LABEL_MAX_CHARS = 80;
const MODEL_LABEL_MAX_CHARS = 80;
const NODE_LABEL_MAX_CHARS = 96;

// eslint-disable-next-line no-control-regex
const TERMINAL_ESCAPE_RE = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

function sanitizeTerminalLabel(value: string | undefined, maxChars?: number): string {
  const raw = value || '';
  const bounded = maxChars === undefined ? raw : raw.slice(0, maxChars);
  return bounded.replace(TERMINAL_ESCAPE_RE, '').replace(CONTROL_RE, '');
}

function clampLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export interface SubagentTreeProps {
  repositories: RepositoryNode[];
  /** Max worktrees shown across each repository (most recent). */
  max?: number;
  /** Max role children shown per worktree. */
  maxRoles?: number;
}

function formatDuration(ms: number | undefined): string | undefined {
  if (ms == null) return undefined;
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function worktreeLabel(task: RepositoryNode['worktrees'][number]): string {
  const id = task.issueIdentifier ?? task.taskId;
  const branch = task.branch ? ` ${task.branch}` : task.worktree ? ` worktree/${task.worktree}` : '';
  const stage = task.currentStage ? ` ${task.currentStage}` : '';
  const duration = formatDuration(task.durationMs);
  const decision = task.decision ? ` ${task.decision}` : '';
  const title = task.title ? ` ${task.title}` : '';
  return sanitizeTerminalLabel(`${id}${branch}${stage}${duration ? ` ${duration}` : ''}${decision}${title}`, NODE_LABEL_MAX_CHARS);
}

export function SubagentTree({ repositories, max = 6, maxRoles = 5 }: SubagentTreeProps) {
  const worktreeLimit = clampLimit(max);
  const roleLimit = clampLimit(maxRoles);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!repositories.some((repo) => repo.worktrees.some((task) => task.roles.some((role) => role.status === 'start')))) return;
    const timer = setInterval(() => setTick((value) => value + 1), 120);
    return () => clearInterval(timer);
  }, [repositories]);

  return (
    <Box flexDirection="column">
      <Text bold>Agents by repository</Text>
      {repositories.length === 0 || worktreeLimit === 0 ? (
        <Text dimColor>(no active agents)</Text>
      ) : (
        repositories.map((repo) => (
          <Box key={repo.repository} flexDirection="column">
            <Text color={STATUS[KIND[repo.status]].color}>{`${STATUS[KIND[repo.status]].icon} ${sanitizeTerminalLabel(repo.repository, NODE_LABEL_MAX_CHARS)}`}</Text>
            {repo.worktrees.slice(-worktreeLimit).map((task) => (
              <Box key={`${repo.repository}:${task.taskId}`} flexDirection="column">
                <Text dimColor>{`  └ ${worktreeLabel(task)} — ${task.status}`}</Text>
                {(roleLimit === 0 ? [] : task.roles.slice(-roleLimit)).map((role, i) => (
                  <Text key={i} dimColor>
                    {`     └ ${role.status === 'start' ? spinnerFrame(tick) : ''} ${sanitizeTerminalLabel(role.role, STAGE_LABEL_MAX_CHARS)}${role.model ? ` (${sanitizeTerminalLabel(role.model, MODEL_LABEL_MAX_CHARS)})` : ''} — ${role.status}${role.activity ? ` · ${sanitizeTerminalLabel(role.activity, STAGE_LABEL_MAX_CHARS)}` : ''}${role.rateLimitResetsAt ? ` · reset ${new Date(role.rateLimitResetsAt).toISOString()}` : ''}${role.decision ? `/${role.decision}` : ''}`}
                  </Text>
                ))}
              </Box>
            ))}
          </Box>
        ))
      )}
    </Box>
  );
}
