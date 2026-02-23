// ============================================
// OpenSwarm - Linear Project Updater
// Project Status Update + Overview auto-refresh
// ============================================

import { LinearClient } from '@linear/sdk';
import { getPipelineHistory, type PipelineHistoryEntry } from '../automation/runnerState.js';
import { getDateLocale } from '../locale/index.js';

// Debounce: prevent duplicate calls within 60 seconds per project
const lastUpdateTime = new Map<string, number>();
const DEBOUNCE_MS = 60_000;

// LinearClient is initialized in linear.ts. Must be set separately here.
let client: LinearClient | null = null;

export function setLinearClient(c: LinearClient): void {
  client = c;
}

function getClient(): LinearClient {
  if (!client) throw new Error('projectUpdater: LinearClient not set');
  return client;
}

export interface CompletedTaskInfo {
  title: string;
  success: boolean;
  duration: number;
  issueIdentifier?: string;
  cost?: number;
}

/**
 * Update Linear project Status + Overview after task completion
 */
export async function updateProjectAfterTask(
  projectId: string,
  projectName: string,
  task: CompletedTaskInfo,
): Promise<void> {
  // Debounce
  const last = lastUpdateTime.get(projectId) ?? 0;
  if (Date.now() - last < DEBOUNCE_MS) return;
  lastUpdateTime.set(projectId, Date.now());

  await postStatusUpdate(projectId, projectName, task);
  await refreshProjectOverview(projectId);
}

// ============================================
// B-1. Create Status Update
// ============================================

async function postStatusUpdate(
  projectId: string,
  projectName: string,
  _task: CompletedTaskInfo,
): Promise<void> {
  const linear = getClient();
  const today = new Date().toLocaleDateString(getDateLocale(), { year: 'numeric', month: '2-digit', day: '2-digit' });

  // Filter today's records
  const todayStr = new Date().toISOString().slice(0, 10);
  const history = getPipelineHistory(100);
  const todayEntries = history.filter(e =>
    e.projectName === projectName && e.completedAt.startsWith(todayStr)
  );

  const completed = todayEntries.filter(e => e.success);
  const failed = todayEntries.filter(e => !e.success);
  const totalCost = todayEntries.reduce((sum, e) => sum + (e.cost?.costUsd ?? 0), 0);

  // Summarize recent 5 entries
  const recentLines = todayEntries.slice(0, 5).map(e => {
    const id = e.issueIdentifier || e.taskTitle.slice(0, 20);
    const icon = e.success ? '\u2713' : '\u2717';
    const dur = formatDuration(e.totalDuration);
    const costStr = e.cost?.costUsd ? ` $${e.cost.costUsd.toFixed(2)}` : '';
    return `- ${icon} ${id}: ${e.taskTitle.slice(0, 40)} (${dur}${costStr})`;
  }).join('\n');

  const body = `## Automation Activity (${today})

### Recent
${recentLines || '(none)'}

### Stats
| Item | Value |
|------|-------|
| Completed | ${completed.length} |
| Failed | ${failed.length} |
| Total Cost | $${totalCost.toFixed(2)} |
`;

  // Determine health
  let health: string = 'onTrack';
  if (failed.length > completed.length) health = 'offTrack';
  else if (failed.length > 0) health = 'atRisk';

  try {
    await linear.createProjectUpdate({
      projectId,
      body,
      health: health as any,
    });
    console.log(`[ProjectUpdater] Status update posted for "${projectName}" (health=${health})`);
  } catch (err) {
    console.warn(`[ProjectUpdater] Failed to post status update:`, err);
  }
}

// ============================================
// B-2. Project Overview refresh
// ============================================

const AUTOMATION_SECTION_MARKER = '## Automation Status';

async function refreshProjectOverview(projectId: string): Promise<void> {
  const linear = getClient();

  try {
    const project = await linear.project(projectId);
    if (!project) return;

    // Issue stats: count issues by state for this project
    const issues = await project.issues({ first: 250 });
    const stateCounts = new Map<string, number>();
    for (const issue of issues.nodes) {
      const state = (await issue.state)?.name ?? 'Unknown';
      stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
    }

    // Recent 5 pipeline history entries
    const history = getPipelineHistory(50);
    const projectHistory = history.filter(e => e.projectName === project.name).slice(0, 5);
    const recentStr = projectHistory.map(e => {
      const id = e.issueIdentifier || '?';
      return `${id} ${e.success ? '\u2713' : '\u2717'}`;
    }).join(', ') || '(none)';

    const now = new Date().toLocaleString(getDateLocale());
    const stateRows = ['Done', 'In Progress', 'In Review', 'Todo', 'Backlog']
      .filter(s => stateCounts.has(s))
      .map(s => `| ${s} | ${stateCounts.get(s)} |`)
      .join('\n');

    const section = `${AUTOMATION_SECTION_MARKER}
> Last updated: ${now}

| State | Issues |
|-------|--------|
${stateRows}

**Recent 5**: ${recentStr}
`;

    // Replace automation section in existing description, or append
    const currentDesc = project.description ?? '';
    const markerIdx = currentDesc.indexOf(AUTOMATION_SECTION_MARKER);

    let newDesc: string;
    if (markerIdx >= 0) {
      // Replace existing section (from marker to end)
      newDesc = currentDesc.slice(0, markerIdx) + section;
    } else {
      // Append to end of existing description
      newDesc = currentDesc + '\n\n' + section;
    }

    await linear.updateProject(projectId, { description: newDesc });
    console.log(`[ProjectUpdater] Project overview updated for "${project.name}"`);
  } catch (err) {
    console.warn(`[ProjectUpdater] Failed to update project overview:`, err);
  }
}

// ============================================
// Helpers
// ============================================

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}
