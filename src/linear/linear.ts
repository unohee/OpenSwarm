// ============================================
// OpenSwarm - Linear Integration
// ============================================

import { LinearClient } from '@linear/sdk';
import type { LinearIssueInfo, LinearProjectInfo } from '../core/types.js';
import { getDateLocale } from '../locale/index.js';
import { setLinearClient } from './projectUpdater.js';
import { withRateLimit } from '../support/rateLimiter.js';

/**
 * Extract project info from an issue
 */
async function getProjectInfo(issue: any): Promise<LinearProjectInfo | undefined> {
  try {
    const project = await issue.project;
    if (!project) return undefined;
    return {
      id: project.id,
      name: project.name,
      icon: project.icon ?? undefined,
      color: project.color ?? undefined,
    };
  } catch {
    return undefined;
  }
}

let client: LinearClient | null = null;
let teamId: string = '';
let teamIds: string[] = [];

/** Build a Linear team filter that works for both single and multiple team IDs */
function teamFilter() {
  if (teamIds.length === 1) {
    return { id: { eq: teamIds[0] } };
  }
  return { id: { in: teamIds } };
}

/**
 * Page size when fetching issues across all configured teams. Linear's
 * default page cap is 50 — 100 is the largest value that consistently
 * returns; bumping to 250 triggered intermittent 502s from the Linear
 * gateway on wider queries.
 *
 * A prior revision tried per-team fan-out to guarantee a per-team quota, but
 * firing ~12 parallel `issues()` calls tripped a 90s timeout inside the
 * Linear SDK / HTTP keepalive path — one wider query is both simpler and
 * actually faster end-to-end.
 */
const FETCH_PAGE_SIZE = 100;

async function fetchIssuesForStates(
  linear: LinearClient,
  stateNames: string[],
  extraFilter: Record<string, unknown> = {},
): Promise<{ nodes: Array<Awaited<ReturnType<LinearClient['issues']>>['nodes'][number]> }> {
  const ids = teamIds.length > 0 ? teamIds : (teamId ? [teamId] : []);

  // Single-team / no-team fallback uses the shared filter path.
  if (ids.length <= 1) {
    const res = await withRateLimit('linear', async () =>
      linear.issues({
        filter: { ...extraFilter, team: teamFilter(), state: { name: { in: stateNames } } },
        first: FETCH_PAGE_SIZE,
      }),
    );
    return { nodes: res.nodes };
  }

  // Multi-team: issue one `in: [...]` query rather than fanning out, but run a
  // second query *only if* the first page filled up — that's the signal that
  // some team's issues may have been truncated. This bounds the request count
  // to at most 1 + teams when the result set is actually wide.
  const primary = await withRateLimit('linear', async () =>
    linear.issues({
      filter: { ...extraFilter, team: { id: { in: ids } }, state: { name: { in: stateNames } } },
      first: FETCH_PAGE_SIZE,
    }),
  );

  if (primary.nodes.length < FETCH_PAGE_SIZE) {
    return { nodes: primary.nodes };
  }

  // First page was saturated → fall back to per-team fan-out so no team is starved.
  // Dedup by issue id when concatenating.
  const pages = await Promise.all(
    ids.map((tid) =>
      withRateLimit('linear', async () =>
        linear.issues({
          filter: { ...extraFilter, team: { id: { eq: tid } }, state: { name: { in: stateNames } } },
          first: FETCH_PAGE_SIZE,
        }),
      ),
    ),
  );
  const seen = new Set<string>();
  const merged: typeof primary.nodes = [];
  for (const node of [...primary.nodes, ...pages.flatMap((p) => p.nodes)]) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    merged.push(node);
  }
  return { nodes: merged };
}

// Daily issue creation limit
const DAILY_ISSUE_LIMIT = 10;
let dailyIssueCount = 0;
let lastResetDate: string = '';

// Caching Layer

interface CachedIssues {
  data: LinearIssueInfo[];
  timestamp: number;
  agentLabel: string;
}

const inProgressCache = new Map<string, CachedIssues>();
const backlogCache = new Map<string, CachedIssues>();
const myIssuesCache = new Map<string, CachedIssues>();
const CACHE_TTL_MS = 300000; // 5 minute cache (was 1min, reduced API calls)

function isCacheValid(cache: CachedIssues | undefined): boolean {
  if (!cache) return false;
  return Date.now() - cache.timestamp < CACHE_TTL_MS;
}

/**
 * Clear all caches (call when issues are mutated)
 */
export function clearLinearCache(): void {
  inProgressCache.clear();
  backlogCache.clear();
  myIssuesCache.clear();
  console.log('[Linear] Cache cleared');
}

/**
 * Reset daily counter on date change
 */
function resetDailyCounterIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (today !== lastResetDate) {
    dailyIssueCount = 0;
    lastResetDate = today;
  }
}

/**
 * Remaining issue creation quota for today
 */
export function getRemainingDailyIssues(): number {
  resetDailyCounterIfNeeded();
  return Math.max(0, DAILY_ISSUE_LIMIT - dailyIssueCount);
}

/**
 * Number of issues created today
 */
export function getDailyIssueCount(): number {
  resetDailyCounterIfNeeded();
  return dailyIssueCount;
}

/**
 * Initialize the Linear client
 * Rate limiting is applied at the function level in this file
 */
export function initLinear(apiKey: string, team: string): void {
  client = new LinearClient({ apiKey });
  teamId = team;
  teamIds = team.split(',').map(id => id.trim()).filter(Boolean);
  setLinearClient(client);
  console.log('[Linear] Client initialized');
}

/**
 * Check if Linear client is initialized
 */
export function isLinearInitialized(): boolean {
  return client !== null;
}

/**
 * Return the Linear client instance
 */
export function getClient(): LinearClient {
  if (!client) {
    throw new Error('Linear client not initialized. Call initLinear() first.');
  }
  return client;
}

/**
 * Get in-progress issues for an agent (with caching)
 */
export async function getInProgressIssues(
  agentLabel: string
): Promise<LinearIssueInfo[]> {
  if (!isLinearInitialized()) return [];
  // Check cache first
  const cached = inProgressCache.get(agentLabel);
  if (cached && isCacheValid(cached)) {
    console.log(`[Linear] Using cached in-progress issues for ${agentLabel}`);
    return cached.data;
  }

  console.log(`[Linear] Fetching in-progress issues for ${agentLabel}`);
  const linear = getClient();

  const issues = await withRateLimit('linear', async () => linear.issues({
    filter: {
      team: teamFilter(),
      state: { name: { in: ['In Progress', 'Started'] } },
      labels: { name: { eq: agentLabel } },
    },
  }));

  const result: LinearIssueInfo[] = [];

  // Batch fetch all related data to minimize API calls
  for (const issue of issues.nodes) {
    // Use Promise.all to parallelize, but still results in N queries per issue
    // Linear SDK doesn't support includes/eager loading, so this is unavoidable
    const [comments, labels, state, project] = await Promise.all([
      issue.comments(),
      issue.labels(),
      issue.state,
      getProjectInfo(issue),
    ]);

    result.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      state: state?.name ?? 'Unknown',
      priority: issue.priority,
      labels: labels.nodes.map((l) => l.name),
      comments: comments.nodes.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        user: undefined, // TODO: resolve user name
      })),
      project,
    });
  }

  // Cache the result
  inProgressCache.set(agentLabel, {
    data: result,
    timestamp: Date.now(),
    agentLabel,
  });

  return result;
}

/**
 * Get the next issue from the backlog (with caching)
 */
export async function getNextBacklogIssue(
  agentLabel: string
): Promise<LinearIssueInfo | null> {
  if (!isLinearInitialized()) return null;
  // Check cache first
  const cached = backlogCache.get(agentLabel);
  if (cached && isCacheValid(cached) && cached.data.length > 0) {
    console.log(`[Linear] Using cached backlog issue for ${agentLabel}`);
    return cached.data[0];
  }

  console.log(`[Linear] Fetching backlog issues for ${agentLabel}`);
  const linear = getClient();

  const issues = await withRateLimit('linear', async () => linear.issues({
    filter: {
      team: teamFilter(),
      state: { name: { in: ['Backlog', 'Todo'] } },
      labels: { name: { eq: agentLabel } },
    },
    first: 10, // Fetch multiple and sort by priority
  }));

  // Sort by priority (lower = higher priority: 1=Urgent, 4=Low, 0=None)
  const sorted = [...issues.nodes].sort((a, b) => {
    // Push priority 0 (None) to the end
    const pa = a.priority === 0 ? 999 : a.priority;
    const pb = b.priority === 0 ? 999 : b.priority;
    return pa - pb;
  });

  const issue = sorted[0];
  if (!issue) return null;

  const [comments, labels, state, project] = await Promise.all([
    issue.comments(),
    issue.labels(),
    issue.state,
    getProjectInfo(issue),
  ]);

  const result = {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? undefined,
    state: state?.name ?? 'Unknown',
    priority: issue.priority,
    labels: labels.nodes.map((l) => l.name),
    comments: comments.nodes.map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
      user: undefined,
    })),
    project,
  };

  // Cache the result
  backlogCache.set(agentLabel, {
    data: [result],
    timestamp: Date.now(),
    agentLabel,
  });

  return result;
}

/**
 * Options for getMyIssues
 */
export interface GetMyIssuesOptions {
  agentLabel?: string;
  /**
   * Slim mode: skip N+1 queries for comments/labels/project.
   * Returns only core fields (id, identifier, title, description, priority, state, project).
   * Use for heartbeat/decision engine where full details aren't needed.
   */
  slim?: boolean;
  /** Timeout in ms (default: 30000) */
  timeoutMs?: number;
}

/**
 * Get assigned active issues (with caching)
 * (Todo, In Progress, Review states - excludes Backlog)
 */
export async function getMyIssues(
  agentLabelOrOptions?: string | GetMyIssuesOptions
): Promise<LinearIssueInfo[]> {
  if (!isLinearInitialized()) return [];
  const opts: GetMyIssuesOptions = typeof agentLabelOrOptions === 'string'
    ? { agentLabel: agentLabelOrOptions }
    : agentLabelOrOptions ?? {};

  const { agentLabel, slim = false, timeoutMs = 30000 } = opts;

  // Generate cache key
  const cacheKey = `${agentLabel || 'all'}:${slim}`;

  // Check cache first
  const cached = myIssuesCache.get(cacheKey);
  if (cached && isCacheValid(cached)) {
    console.log(`[Linear] Using cached issues for ${cacheKey}`);
    return cached.data;
  }

  console.log(`[Linear] Fetching issues for ${cacheKey}`);
  const linear = getClient();

  // Wrap with timeout
  const fetchIssues = async (): Promise<LinearIssueInfo[]> => {
    // Slim mode: query each state separately to avoid lazy resolver calls for issue.state
    // Full mode: combined query then resolve per-issue
    const result: LinearIssueInfo[] = [];

    const extraFilter: Record<string, unknown> = {};
    if (agentLabel) extraFilter.labels = { name: { eq: agentLabel } };

    if (slim) {
      // Separate queries per state → tag each issue without resolver calls.
      const [todoIssues, inProgressIssues, backlogIssues] = await Promise.all([
        fetchIssuesForStates(linear, ['Todo'], extraFilter),
        fetchIssuesForStates(linear, ['In Progress', 'In Review'], extraFilter),
        fetchIssuesForStates(linear, ['Backlog'], extraFilter),
      ]);

      const withState = [
        ...todoIssues.nodes.map(i => ({ issue: i, state: 'Todo' })),
        ...inProgressIssues.nodes.map(i => ({ issue: i, state: 'In Progress' })),
        ...backlogIssues.nodes.map(i => ({ issue: i, state: 'Backlog' })),
      ];

      // Resolve all project info in parallel (one API call per issue, but batched)
      // issue.project returns id+name together, cache by project id to avoid duplicates
      const projectCache = new Map<string, LinearProjectInfo>();
      const projectResolutions = await Promise.all(
        withState.map(({ issue }) =>
          withRateLimit('linear', () => Promise.resolve(issue.project) as Promise<any>).catch(() => null)
        )
      );
      for (const p of projectResolutions) {
        if (p && !projectCache.has(p.id)) {
          projectCache.set(p.id, { id: p.id, name: p.name, icon: p.icon ?? undefined, color: p.color ?? undefined });
        }
      }

      for (let i = 0; i < withState.length; i++) {
        const { issue, state } = withState[i];
        const p = projectResolutions[i];
        const project = p ? projectCache.get(p.id) : undefined;
        result.push({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description ?? undefined,
          state,
          priority: issue.priority,
          labels: [],
          comments: [],
          project,
        } as LinearIssueInfo);
      }

      return result;
    }

    // Full mode: fetch executable + backlog, then resolve per-issue
    const [executableIssues, backlogIssues] = await Promise.all([
      fetchIssuesForStates(linear, ['Todo', 'In Progress', 'In Review'], extraFilter),
      fetchIssuesForStates(linear, ['Backlog'], extraFilter),
    ]);

    {
      // Full mode: load all details (comments, labels, project)
      const allNodes = [...executableIssues.nodes, ...backlogIssues.nodes];
      for (const issue of allNodes) {
        const [comments, labels, project] = await Promise.all([
          issue.comments(),
          issue.labels(),
          getProjectInfo(issue),
        ]);

        result.push({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description ?? undefined,
          state: (await issue.state)?.name ?? 'Unknown',
          priority: issue.priority,
          labels: labels.nodes.map((l: { name: string }) => l.name),
          comments: comments.nodes.map((c: { id: string; body: string; createdAt: Date }) => ({
            id: c.id,
            body: c.body,
            createdAt: c.createdAt.toISOString(),
            user: undefined,
          })),
          project,
        });
      }
    }

    // Sort by priority
    return result.sort((a, b) => {
      const pa = a.priority === 0 ? 999 : a.priority;
      const pb = b.priority === 0 ? 999 : b.priority;
      return pa - pb;
    });
  };

  // Apply timeout
  const result = await Promise.race([
    fetchIssues(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`getMyIssues timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);

  // Cache the result
  myIssuesCache.set(cacheKey, {
    data: result,
    timestamp: Date.now(),
    agentLabel: agentLabel || 'all',
  });

  return result;
}

/**
 * Get a specific issue by ID or identifier
 */
export async function getIssue(issueIdOrIdentifier: string): Promise<LinearIssueInfo | null> {
  if (!isLinearInitialized()) return null;
  const linear = getClient();

  try {
    // Check if it's an identifier format (e.g., LIN-123)
    const isIdentifier = /^[A-Z]+-\d+$/.test(issueIdOrIdentifier);

    let issue;
    if (isIdentifier) {
      // Search by identifier - use number field
      const numPart = issueIdOrIdentifier.split('-')[1];
      const issueNumber = parseInt(numPart, 10);

      const issues = await linear.issues({
        filter: {
          team: teamFilter(),
          number: { eq: issueNumber },
        },
        first: 1,
      });
      issue = issues.nodes[0];
    } else {
      // Look up directly by ID
      issue = await linear.issue(issueIdOrIdentifier);
    }

    if (!issue) return null;

    const [comments, labels, project] = await Promise.all([
      issue.comments(),
      issue.labels(),
      getProjectInfo(issue),
    ]);

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      state: (await issue.state)?.name ?? 'Unknown',
      priority: issue.priority,
      labels: labels.nodes.map((l) => l.name),
      comments: comments.nodes.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        user: undefined,
      })),
      project,
    };
  } catch (error) {
    console.error(`[Linear] getIssue error for ${issueIdOrIdentifier}:`, error);
    return null;
  }
}

/**
 * Update issue state
 */
export async function updateIssueState(
  issueId: string,
  stateName: 'In Progress' | 'In Review' | 'Done' | 'Backlog' | 'Todo',
  retries = 2
): Promise<void> {
  if (!isLinearInitialized()) return;
  const linear = getClient();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Fetch the issue to get its actual team ID (avoids cross-team state mismatch)
      const issue = await linear.issue(issueId);
      const issueTeam = await issue.team;
      const resolvedTeamId = issueTeam?.id ?? teamIds[0] ?? teamId;

      // Get team workflow states
      const team = await linear.team(resolvedTeamId);
      const states = await team.states();
      const targetState = states.nodes.find((s) =>
        s.name.toLowerCase().includes(stateName.toLowerCase())
      );

      if (!targetState) {
        console.error(`[Linear] State "${stateName}" not found in team workflow`);
        return;
      }

      await linear.updateIssue(issueId, {
        stateId: targetState.id,
      });

      // Clear cache after mutation
      clearLinearCache();

      console.log(`[Linear] Issue ${issueId} state changed to ${stateName}`);
      return;
    } catch (error) {
      console.error(`[Linear] Failed to update issue state (attempt ${attempt + 1}/${retries + 1}):`, error);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  console.error(`[Linear] All ${retries + 1} attempts to update issue ${issueId} to "${stateName}" failed`);
}

/**
 * Add a comment to an issue
 */
export async function addComment(
  issueId: string,
  body: string
): Promise<void> {
  if (!isLinearInitialized()) return;
  const linear = getClient();

  await linear.createComment({
    issueId,
    body,
  });
}

/** Log a HALT event (low confidence) as a comment on a Linear issue */
export async function logHalt(
  issueId: string, sessionId: string, confidence: number, iteration: number, reason: string,
): Promise<void> {
  await addComment(issueId,
    `⚠️ **[Automation] HALT - Low Confidence**\n\nSession: \`${sessionId}\` | Confidence: ${confidence}% | Attempt: #${iteration}\nReason: ${reason}\n\n**Action Required:** Review task requirements / provide context / break into sub-tasks\n\n---\n_Auto-generated_`);
}

/** Log work start comment for an agent */
export async function logWorkStart(issueId: string, sessionName: string): Promise<void> {
  await addComment(issueId,
    `🤖 **[${sessionName}] Work Started**\n\nTime: ${new Date().toISOString()}\n\n---\n_Auto-generated_`);
  await updateIssueState(issueId, 'In Progress');
}

/**
 * Log progress comment for an agent
 */
export async function logProgress(
  issueId: string,
  sessionName: string,
  progress: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  const body = `🤖 **[${sessionName}] Progress Update**

${progress}

Time: ${timestamp}`;

  await addComment(issueId, body);
}

/**
 * Log work completion comment for an agent
 */
export async function logWorkComplete(
  issueId: string,
  sessionName: string,
  summary?: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  const body = `🤖 **[${sessionName}] ✅ Work Complete**

${summary ?? ''}

Time: ${timestamp}`;

  await addComment(issueId, body);
  await updateIssueState(issueId, 'Done');
}

/**
 * Log blocked comment for an agent
 */
export async function logBlocked(
  issueId: string,
  sessionName: string,
  reason: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  const body = `🤖 **[${sessionName}] ⚠️ Blocked**

Reason: ${reason}

User intervention required

Time: ${timestamp}`;

  await addComment(issueId, body);
  // Use 'Todo' instead of 'Blocked' (Blocked state may not exist in team workflow)
  await updateIssueState(issueId, 'Todo');
}

// Pair Mode Linear Integration

/**
 * Log pair session start comment
 */
export async function logPairStart(
  issueId: string,
  sessionId: string,
  projectPath: string
): Promise<void> {
  const timestamp = new Date().toLocaleString(getDateLocale());
  const body = `👥 **[Pair Session] Work Started**

🆔 Session: \`${sessionId}\`
📁 Project: \`${projectPath}\`
⏰ Time: ${timestamp}

Starting work in Worker/Reviewer pair mode.

---
_Auto-generated_`;

  await addComment(issueId, body);
  await updateIssueState(issueId, 'In Progress');
}

/**
 * Log pair session review start comment
 */
export async function logPairReview(
  issueId: string,
  sessionId: string,
  attempt: number
): Promise<void> {
  const timestamp = new Date().toLocaleString(getDateLocale());
  const body = `🔍 **[Pair Session] Reviewing**

🆔 Session: \`${sessionId}\`
🔢 Attempt: #${attempt}
⏰ Time: ${timestamp}

Reviewer is reviewing Worker's output.`;

  await addComment(issueId, body);
  await updateIssueState(issueId, 'In Review');
}

/**
 * Log pair session revision request comment
 */
export async function logPairRevision(
  issueId: string,
  sessionId: string,
  feedback: string,
  issues: string[]
): Promise<void> {
  const timestamp = new Date().toLocaleString(getDateLocale());
  const issueList = issues.length > 0
    ? issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')
    : '(none)';

  const body = `🔄 **[Pair Session] Revision Requested**

🆔 Session: \`${sessionId}\`
⏰ Time: ${timestamp}

**Feedback:** ${feedback}

**Issues:**
${issueList}

Worker will proceed with revisions.`;

  await addComment(issueId, body);
  await updateIssueState(issueId, 'In Progress');
}

/**
 * Log pair session completion comment
 */
export async function logPairComplete(
  issueId: string,
  sessionId: string,
  stats: {
    attempts: number;
    duration: number;
    filesChanged: string[];
    workerSummary?: string;
    workerCommands?: string[];
    reviewerFeedback?: string;
    reviewerDecision?: string;
    testResults?: {
      passed: number;
      failed: number;
      coverage?: number;
      failedTests?: string[];
    };
    remainingWork?: string;
  }
): Promise<void> {
  const timestamp = new Date().toLocaleString(getDateLocale());
  const durationStr = stats.duration < 60
    ? `${stats.duration}s`
    : `${Math.floor(stats.duration / 60)}m ${stats.duration % 60}s`;

  const filesStr = stats.filesChanged.length > 0
    ? stats.filesChanged.slice(0, 10).map(f => `- \`${f}\``).join('\n')
    : '(none)';

  // Build sections
  const sections = [];

  // Worker section
  if (stats.workerSummary) {
    sections.push(`## 🔨 Worker Report

**What was done:**
${stats.workerSummary}`);

    if (stats.workerCommands && stats.workerCommands.length > 0) {
      const cmdStr = stats.workerCommands.slice(0, 5).map(c => `- \`${c}\``).join('\n');
      sections.push(`**Commands executed:**
${cmdStr}`);
    }
  }

  // Reviewer section
  if (stats.reviewerFeedback) {
    sections.push(`## ✅ Reviewer Report

**Decision:** ${stats.reviewerDecision || 'APPROVE'}

**Feedback:**
${stats.reviewerFeedback}`);
  }

  // Tester section
  if (stats.testResults) {
    const { passed, failed, coverage, failedTests } = stats.testResults;
    const totalTests = passed + failed;
    const passRate = totalTests > 0 ? ((passed / totalTests) * 100).toFixed(1) : '0';

    let testSection = `## 🧪 Test Results

- ✅ Passed: ${passed}/${totalTests} (${passRate}%)`;

    if (coverage !== undefined) {
      testSection += `\n- 📊 Coverage: ${coverage.toFixed(1)}%`;
    }

    if (failed > 0 && failedTests && failedTests.length > 0) {
      const failedStr = failedTests.slice(0, 3).map(t => `- ❌ ${t}`).join('\n');
      testSection += `\n\n**Failed tests:**\n${failedStr}`;
      if (failedTests.length > 3) {
        testSection += `\n- ... and ${failedTests.length - 3} more`;
      }
    }

    sections.push(testSection);
  }

  // Remaining work section
  if (stats.remainingWork) {
    sections.push(`## 📋 Remaining Work

${stats.remainingWork}`);
  }

  const body = `✅ **[Automation] Task Complete**

🆔 Session: \`${sessionId}\`
⏰ Completed: ${timestamp}

**📊 Summary:**
- 🔄 Iterations: ${stats.attempts}
- ⏱️ Duration: ${durationStr}
- 📁 Files changed: ${stats.filesChanged.length}

**Changed files:**
${filesStr}

---

${sections.join('\n\n---\n\n')}

---
_Automated by Worker/Reviewer/Tester pipeline_`;

  await addComment(issueId, body);
  await updateIssueState(issueId, 'Done');
}

/**
 * Log pair session failure/rejection comment
 */
export async function logPairFailed(
  issueId: string,
  sessionId: string,
  reason: 'rejected' | 'max_attempts' | 'error',
  details: string
): Promise<void> {
  const timestamp = new Date().toLocaleString(getDateLocale());
  const reasonText = {
    rejected: '❌ Reviewer rejected the work',
    max_attempts: '⚠️ Maximum retry attempts exceeded',
    error: '💥 An error occurred',
  }[reason];

  const body = `❌ **[Pair Session] Work Failed**

🆔 Session: \`${sessionId}\`
⏰ Time: ${timestamp}

**Reason:** ${reasonText}

**Details:**
${details}

---
_Manual intervention required_`;

  await addComment(issueId, body);
  // Don't change state on failure; let the user decide
}

/**
 * Create a new issue (with daily limit enforcement)
 */
export async function createIssue(
  title: string,
  description: string,
  labels: string[] = [],
  options?: { bypassLimit?: boolean }
): Promise<LinearIssueInfo | { error: string }> {
  if (!isLinearInitialized()) return { error: 'Linear not configured' };
  resetDailyCounterIfNeeded();

  // Check daily limit (unless bypassLimit is set)
  if (!options?.bypassLimit && dailyIssueCount >= DAILY_ISSUE_LIMIT) {
    return {
      error: `Daily issue creation limit (${DAILY_ISSUE_LIMIT}) reached. Please try again tomorrow.`,
    };
  }

  const linear = getClient();

  // Look up label IDs
  const team = await linear.team(teamIds[0] ?? teamId);
  const teamLabels = await team.labels();
  const labelIds = labels
    .map((name) => teamLabels.nodes.find((l) => l.name === name)?.id)
    .filter((id): id is string => !!id);

  const issuePayload = await linear.createIssue({
    teamId,
    title,
    description,
    labelIds,
  });

  const issue = await issuePayload.issue;
  if (!issue) {
    throw new Error('Failed to create issue');
  }

  // Increment counter
  dailyIssueCount++;

  // Clear cache after mutation
  clearLinearCache();

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? undefined,
    state: 'Backlog',
    priority: issue.priority,
    labels,
    comments: [],
  };
}

/**
 * Create a sub-issue (for Planner decomposition)
 * - Creates as a child of the parent issue via parentId
 * - Exempt from daily limit (auto-decomposition is required work)
 */
export async function createSubIssue(
  parentId: string,
  title: string,
  description: string,
  options?: {
    priority?: number;  // 1=Urgent, 2=High, 3=Normal, 4=Low
    labels?: string[];
    projectId?: string;
    estimatedMinutes?: number;
  }
): Promise<LinearIssueInfo | { error: string }> {
  if (!isLinearInitialized()) return { error: 'Linear not configured' };
  const linear = getClient();

  try {
    // Get parent issue info
    const parentIssue = await linear.issue(parentId);
    if (!parentIssue) {
      return { error: `Parent issue not found: ${parentId}` };
    }

    // Look up label IDs
    const team = await linear.team(teamIds[0] ?? teamId);
    const teamLabels = await team.labels();
    const labelIds = (options?.labels || [])
      .map((name) => teamLabels.nodes.find((l) => l.name === name)?.id)
      .filter((id): id is string => !!id);

    // Add auto-decomposed label
    const autoLabel = teamLabels.nodes.find((l) => l.name === 'auto-decomposed');
    if (autoLabel) {
      labelIds.push(autoLabel.id);
    }

    // Create the sub-issue (use parent issue's team ID, not global)
    const parentTeam = await parentIssue.team;
    const subIssueTeamId = parentTeam?.id ?? (teamIds[0] ?? teamId);
    const issuePayload = await linear.createIssue({
      teamId: subIssueTeamId,
      parentId,  // Link to parent issue
      title,
      description,
      labelIds,
      priority: options?.priority ?? 3,
      projectId: options?.projectId,
    });

    const issue = await issuePayload.issue;
    if (!issue) {
      throw new Error('Failed to create sub-issue');
    }

    console.log(`[Linear] Created sub-issue: ${issue.identifier} under ${parentIssue.identifier}`);

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      state: 'Backlog',
      priority: issue.priority,
      labels: options?.labels || [],
      comments: [],
    };
  } catch (error) {
    console.error('[Linear] createSubIssue error:', error);
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Mark a parent issue as 'decomposed'
 */
export async function markAsDecomposed(
  issueId: string,
  subIssueCount: number,
  totalMinutes: number
): Promise<void> {
  const timestamp = new Date().toLocaleString(getDateLocale());
  const body = `📋 **[Planner] Task Decomposition Complete**

⏰ Time: ${timestamp}

**Decomposition result:**
- Sub-issues created: ${subIssueCount}
- Total estimated time: ${totalMinutes}min

This issue has been decomposed into sub-issues.
The parent issue remains active while child issues execute.
Once all sub-issues are completed, OpenSwarm will close this issue automatically.

---
_Auto-decomposed by Planner agent_`;

  await addComment(issueId, body);

  // Keep parent issue active until all child issues complete.
  try {
    await updateIssueState(issueId, 'In Progress');
  } catch (err) {
    console.warn('[Linear] Failed to mark decomposed parent as In Progress:', err);
  }

  // Add label (if decomposed label exists)
  try {
    const linear = getClient();
    const team = await linear.team(teamIds[0] ?? teamId);
    const teamLabels = await team.labels();
    const decomposedLabel = teamLabels.nodes.find((l) => l.name === 'decomposed');

    if (decomposedLabel) {
      const issue = await linear.issue(issueId);
      const currentLabels = await issue.labels();
      const currentLabelIds = currentLabels.nodes.map(l => l.id);

      await linear.updateIssue(issueId, {
        labelIds: [...currentLabelIds, decomposedLabel.id],
      });
    }
  } catch (err) {
    console.warn('[Linear] Failed to add decomposed label:', err);
  }
}

/**
 * Agent proposes work by creating a backlog issue
 * - Enforces daily limit of 10
 * - Automatically adds 'agent-proposal' label
 * - Created with low priority (4)
 */
export async function proposeWork(
  sessionName: string,
  title: string,
  rationale: string,
  suggestedApproach?: string
): Promise<LinearIssueInfo | { error: string }> {
  if (!isLinearInitialized()) return { error: 'Linear not configured' };
  resetDailyCounterIfNeeded();

  // Check daily limit
  if (dailyIssueCount >= DAILY_ISSUE_LIMIT) {
    console.log(`[${sessionName}] Daily issue creation limit reached (${dailyIssueCount}/${DAILY_ISSUE_LIMIT})`);
    return {
      error: `Daily issue creation limit (${DAILY_ISSUE_LIMIT}) reached. Please defer the proposal to tomorrow.`,
    };
  }

  const linear = getClient();

  // Look up Backlog state ID
  const team = await linear.team(teamIds[0] ?? teamId);
  const states = await team.states();
  const backlogState = states.nodes.find((s) =>
    s.name.toLowerCase() === 'backlog'
  );

  // Look up label IDs (agent-proposal + sessionName)
  const teamLabels = await team.labels();
  const proposalLabel = teamLabels.nodes.find((l) => l.name === 'agent-proposal');
  const sessionLabel = teamLabels.nodes.find((l) => l.name === sessionName);

  const labelIds: string[] = [];
  if (proposalLabel) labelIds.push(proposalLabel.id);
  if (sessionLabel) labelIds.push(sessionLabel.id);

  // Compose description
  const description = `## 🤖 Agent Proposal

**Proposed by:** ${sessionName}
**Created at:** ${new Date().toISOString()}

---

### Rationale
${rationale}

${suggestedApproach ? `### Suggested Approach\n${suggestedApproach}` : ''}

---
_This issue was auto-created by an agent. Please review and adjust priority or delete as needed._`;

  const issuePayload = await linear.createIssue({
    teamId,
    title: `[Proposal] ${title}`,
    description,
    labelIds,
    stateId: backlogState?.id,
    priority: 4, // Low priority
  });

  const issue = await issuePayload.issue;
  if (!issue) {
    throw new Error('Failed to create proposal issue');
  }

  // Increment counter
  dailyIssueCount++;

  console.log(`[${sessionName}] Proposal created: ${issue.identifier} (today ${dailyIssueCount}/${DAILY_ISSUE_LIMIT})`);

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? undefined,
    state: 'Backlog',
    priority: 4,
    labels: ['agent-proposal', sessionName].filter(Boolean),
    comments: [],
  };
}

/**
 * Get stuck/failed issues and PRs (issues stuck in In Progress for >7 days, or with retry/failed labels)
 */
export async function getStuckIssues(): Promise<{
  stuckIssues: Array<LinearIssueInfo & { stuckDays: number; reason: string }>;
  failedIssues: Array<LinearIssueInfo & { reason: string }>;
}> {
  if (!isLinearInitialized()) {
    return { stuckIssues: [], failedIssues: [] };
  }
  const linear = getClient();
  const now = Date.now();
  const STUCK_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  // Fetch In Progress issues
  const inProgressIssues = await withRateLimit('linear', async () => linear.issues({
    filter: {
      team: teamFilter(),
      state: { name: { eq: 'In Progress' } },
    },
    first: 100,
  }));

  // Fetch issues with retry/failed/blocked labels
  const problematicIssues = await withRateLimit('linear', async () => linear.issues({
    filter: {
      team: teamFilter(),
      state: { name: { nin: ['Done', 'Canceled'] } },
      labels: { name: { in: ['retry', 'failed', 'blocked', 'needs-help'] } },
    },
    first: 100,
  }));

  const stuckIssues: Array<LinearIssueInfo & { stuckDays: number; reason: string }> = [];
  const failedIssues: Array<LinearIssueInfo & { reason: string }> = [];

  // Process In Progress issues (check if stuck)
  for (const issue of inProgressIssues.nodes) {
    const updatedAt = new Date(issue.updatedAt).getTime();
    const stuckMs = now - updatedAt;

    if (stuckMs > STUCK_THRESHOLD_MS) {
      const [state, labels, comments, project] = await Promise.all([
        issue.state,
        issue.labels(),
        issue.comments(),
        getProjectInfo(issue),
      ]);

      const stuckDays = Math.floor(stuckMs / (24 * 60 * 60 * 1000));
      stuckIssues.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? undefined,
        state: state?.name ?? 'Unknown',
        priority: issue.priority,
        labels: labels.nodes.map((l) => l.name),
        comments: comments.nodes.map((c) => ({
          id: c.id,
          body: c.body,
          createdAt: c.createdAt.toISOString(),
          user: undefined,
        })),
        project,
        stuckDays,
        reason: `No updates for ${stuckDays} days`,
      });
    }
  }

  // Process problematic issues (retry, failed, blocked)
  for (const issue of problematicIssues.nodes) {
    const [state, labels, comments, project] = await Promise.all([
      issue.state,
      issue.labels(),
      issue.comments(),
      getProjectInfo(issue),
    ]);

    const labelNames = labels.nodes.map((l) => l.name);
    let reason = 'Unknown issue';

    if (labelNames.includes('failed')) {
      reason = 'Marked as failed';
    } else if (labelNames.includes('retry')) {
      reason = 'Requires retry';
    } else if (labelNames.includes('blocked')) {
      reason = 'Blocked by dependencies';
    } else if (labelNames.includes('needs-help')) {
      reason = 'Needs manual intervention';
    }

    failedIssues.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      state: state?.name ?? 'Unknown',
      priority: issue.priority,
      labels: labelNames,
      comments: comments.nodes.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        user: undefined,
      })),
      project,
      reason,
    });
  }

  return {
    stuckIssues: stuckIssues.sort((a, b) => b.stuckDays - a.stuckDays),
    failedIssues: failedIssues.sort((a, b) => {
      const pa = a.priority === 0 ? 999 : a.priority;
      const pb = b.priority === 0 ? 999 : b.priority;
      return pa - pb;
    }),
  };
}
