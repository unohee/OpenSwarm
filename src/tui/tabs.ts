// ============================================
// OpenSwarm - TUI tab registry (EPIC INT-1813 S3 / INT-1936)
// Pure tab definitions + navigation math — no React/ink, unit-testable.
// Mirrors the 6 panels of the blessed cockpit (chatTui createUI).
// ============================================

export interface TabDef {
  id: 'chat' | 'pipeline' | 'projects' | 'tasks' | 'stuck' | 'issues' | 'logs';
  label: string;
}

export const TABS: readonly TabDef[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'projects', label: 'Projects' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'stuck', label: 'Stuck' },
  { id: 'issues', label: 'Issues' },
  { id: 'logs', label: 'Logs' },
];

/** Move `current` by `delta` with wraparound across the tab count. */
export function nextTab(current: number, delta: number, total: number = TABS.length): number {
  if (!Number.isInteger(total) || total <= 0) return 0;
  if (!Number.isInteger(current) || !Number.isInteger(delta)) return 0;
  return (((current + delta) % total) + total) % total;
}

/** Map a 1-based digit key to a 0-based tab index, or null if out of range. */
export function tabFromDigit(input: string): number | null {
  if (!/^[1-9]$/.test(input)) return null;
  const n = Number(input);
  if (n > TABS.length) return null;
  return n - 1;
}
