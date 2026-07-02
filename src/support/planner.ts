// ============================================
// OpenSwarm - Planner Agent
// Decompose large issues into 30-min sub-tasks
// ============================================

import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { CostInfo } from './costTracker.js';
import { t, getPrompts } from '../locale/index.js';
import type { ImpactAnalysis } from '../knowledge/types.js';
import type { AdapterName } from '../adapters/types.js';
import { getAdapter, spawnCli } from '../adapters/index.js';
import { expandPath } from '../core/config.js';

// Types

export interface PlannerOptions {
  taskTitle: string;
  taskDescription: string;
  projectPath: string;
  projectName?: string;
  timeoutMs?: number;
  model?: string;
  adapterName?: AdapterName;  // CLI adapter (default: configured default)
  maxTurns?: number;  // Max agentic turns for read-only exploration (default 15)
  targetMinutes?: number;  // Target time per sub-task (default 25 min)
  onLog?: (line: string) => void;  // Stream planner stdout to dashboard
  impactAnalysis?: ImpactAnalysis;  // KG 영향 분석 (파일 분리 유도)
  /** Draft Analyzer 결과 (Haiku 사전 분석) */
  draftAnalysis?: {
    taskType: string;
    intentSummary: string;
    relevantFiles: string[];
    suggestedApproach: string;
    projectStats?: string;
  };
}

export interface SubTask {
  title: string;
  description: string;
  estimatedMinutes: number;
  priority: number;  // 1-4 (1=Urgent)
  dependencies?: string[];  // Prerequisite sub-task titles
  fileScope?: string[];  // Files/modules this sub-task will modify — used for parallel conflict detection
}

export interface PlannerResult {
  success: boolean;
  originalIssue: string;
  needsDecomposition: boolean;
  reason?: string;
  subTasks: SubTask[];
  totalEstimatedMinutes: number;
  error?: string;
  costInfo?: CostInfo;
}

// Prompts

function buildPlannerPrompt(options: PlannerOptions): string {
  return getPrompts().buildPlannerPrompt({
    taskTitle: options.taskTitle,
    taskDescription: options.taskDescription,
    projectName: options.projectName || options.projectPath,
    targetMinutes: options.targetMinutes ?? 25,
    impactAnalysis: options.impactAnalysis ?? undefined,
    draftAnalysis: options.draftAnalysis,
  });
}

// Planner Execution

/**
 * Read-only guard appended to the planner prompt. The planner runs through the
 * same agentic loop as the worker (no built-in read-only mode), so the prompt
 * keeps it from mutating the repo — it should explore (read_file/search_files)
 * and emit the JSON plan, nothing else.
 */
const READ_ONLY_GUARD =
  '\n\n---\n' +
  'IMPORTANT — you are PLANNING ONLY. Do NOT edit, write, or create any files. ' +
  'Use read_file and search_files to understand the codebase first, then output your ' +
  'decomposition as the required JSON (in a ```json block) as your final message.';

/**
 * Run the Planner through the OpenSwarm agentic loop (the same path as the
 * Worker), read-only and multi-turn. Replaces the former `claude -p --max-turns 1`
 * shell-out — removes the claude-binary dependency and lets the planner read the
 * code before decomposing. The `PlannerResult` contract is unchanged.
 */
export async function runPlanner(options: PlannerOptions): Promise<PlannerResult> {
  const prompt = buildPlannerPrompt(options) + READ_ONLY_GUARD;

  try {
    const adapter = getAdapter(options.adapterName);
    const cwd = expandPath(options.projectPath);
    // Drop Claude-CLI-style model ids (e.g. `claude-opus-4-7`) — they are not
    // valid on the openrouter/local adapters; fall back to the adapter default.
    // OpenRouter Claude ids carry an org prefix (`anthropic/claude-...`) and pass.
    const model = options.model && !options.model.startsWith('claude-') ? options.model : undefined;

    const raw = await spawnCli(adapter, {
      prompt,
      cwd,
      timeoutMs: options.timeoutMs ?? 600_000,
      model,
      maxTurns: options.maxTurns ?? 15,
      onLog: options.onLog ? (line: string) => options.onLog!(humanizePlannerOutput(line)) : undefined,
      systemPrompt: getPrompts().systemPrompt,
      readOnly: true,
      // Planner is a judgment role — keep reasoning ON (unlike the worker).
    });

    if (raw.exitCode !== 0 && !raw.stdout.trim()) {
      return {
        success: false,
        originalIssue: options.taskTitle,
        needsDecomposition: false,
        subTasks: [],
        totalEstimatedMinutes: 0,
        error: raw.stderr.slice(0, 500) || `Planner adapter exited with code ${raw.exitCode}`,
      };
    }

    return parsePlannerOutput(raw.stdout, options.taskTitle);
  } catch (error) {
    return {
      success: false,
      originalIssue: options.taskTitle,
      needsDecomposition: false,
      subTasks: [],
      totalEstimatedMinutes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Convert planner JSON output to human-readable log line.
 * Handles both the final JSON result and intermediate text.
 */
function humanizePlannerOutput(text: string): string {
  const trimmed = text.trim();

  // Try to parse as planner result JSON
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj === 'object' && obj !== null && 'needsDecomposition' in obj) {
      if (!obj.needsDecomposition) {
        const reason = obj.reason ? `: ${obj.reason.slice(0, 120)}` : '';
        return `✓ No decomposition needed (est. ${obj.totalEstimatedMinutes || '?'}min)${reason}`;
      }
      const tasks = (obj.subTasks || []) as Array<{ title?: string; estimatedMinutes?: number }>;
      const taskList = tasks.map((t, i) => `  ${i + 1}. ${t.title || '?'} (~${t.estimatedMinutes || '?'}min)`).join('\n');
      return `🔀 Decomposed into ${tasks.length} sub-tasks (total ${obj.totalEstimatedMinutes || '?'}min)\n${taskList}`;
    }
  } catch {
    // Not JSON — return as-is
  }

  // Strip markdown code fences
  if (trimmed.startsWith('```')) return '';

  return trimmed;
}

/**
 * Parse Planner output (plain text or stream-json fallback)
 */
function parsePlannerOutput(output: string, originalTitle: string): PlannerResult {
  try {
    // Primary: plain text output — find ```json block directly
    const jsonBlockMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1]) as Record<string, unknown>;
        if ('needsDecomposition' in parsed) {
          console.log('[Planner] Parsed JSON block from plain text output');
          return {
            success: true,
            originalIssue: originalTitle,
            needsDecomposition: Boolean(parsed.needsDecomposition),
            reason: parsed.reason as string | undefined,
            subTasks: Array.isArray(parsed.subTasks) ? parsed.subTasks as SubTask[] : [],
            totalEstimatedMinutes: (parsed.totalEstimatedMinutes as number) || 0,
          };
        }
      } catch { /* not valid JSON, try other methods */ }
    }

    // Fallback: stream-json format (newline-delimited JSON events)
    const lines = output.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === 'result' && typeof event.result === 'string') {
          return parsePlanResult(event.result as string, originalTitle);
        }
      } catch { /* not a complete JSON line */ }
    }

    // Fallback: direct JSON object in text
    const objMatch = output.match(/\{\s*"needsDecomposition"/);
    if (objMatch) {
      return parseDirectJson(output, objMatch.index!, originalTitle);
    }

    return extractFromText(output, originalTitle);
  } catch (error) {
    console.error('[Planner] Parse error:', error);
    return extractFromText(output, originalTitle);
  }
}

/**
 * Parse the planner result text (extracted from Claude output)
 */
function parsePlanResult(resultText: string, originalTitle: string): PlannerResult {
  // Extract JSON block
  const jsonMatch = resultText.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    // Find JSON object directly
    const objMatch = resultText.match(/\{\s*"needsDecomposition"/);
    if (objMatch) {
      return parseDirectJson(resultText, objMatch.index!, originalTitle);
    }
    return extractFromText(resultText, originalTitle);
  }

  const parsed = JSON.parse(jsonMatch[1]) as Record<string, unknown>;
  return {
    success: true,
    originalIssue: originalTitle,
    needsDecomposition: Boolean(parsed.needsDecomposition),
    reason: parsed.reason as string | undefined,
    subTasks: Array.isArray(parsed.subTasks) ? parsed.subTasks as SubTask[] : [],
    totalEstimatedMinutes: (parsed.totalEstimatedMinutes as number) || 0,
  };
}

/**
 * Parse JSON directly
 */
function parseDirectJson(text: string, startIdx: number, originalTitle: string): PlannerResult {
  let depth = 0;
  let endIdx = startIdx;

  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i + 1;
        break;
      }
    }
  }

  try {
    const parsed = JSON.parse(text.slice(startIdx, endIdx));
    return {
      success: true,
      originalIssue: originalTitle,
      needsDecomposition: Boolean(parsed.needsDecomposition),
      reason: parsed.reason,
      subTasks: Array.isArray(parsed.subTasks) ? parsed.subTasks : [],
      totalEstimatedMinutes: parsed.totalEstimatedMinutes || 0,
    };
  } catch {
    return extractFromText(text, originalTitle);
  }
}

/**
 * Extract from text (fallback)
 */
function extractFromText(text: string, originalTitle: string): PlannerResult {
  // Determined that decomposition is not needed
  if (text.toLowerCase().includes('no decomposition') ||
      text.includes('no decomposition needed') ||
      text.includes('single task')) {
    return {
      success: true,
      originalIssue: originalTitle,
      needsDecomposition: false,
      reason: 'Planner determined no decomposition needed',
      subTasks: [],
      totalEstimatedMinutes: 30,
    };
  }

  // Parse failure - log raw output for debugging
  console.error('[Planner] Parse failed - raw output (first 1000 chars):');
  console.error(text.slice(0, 1000));

  // Parse failure - assume decomposition needed by default
  return {
    success: false,
    originalIssue: originalTitle,
    needsDecomposition: true,
    reason: 'Failed to parse planner output',
    subTasks: [],
    totalEstimatedMinutes: 0,
    error: 'Could not parse planner output',
  };
}

// Linear Integration

/**
 * Create sub-tasks as Linear sub-issues
 */
export async function createLinearSubIssues(
  parentIssueId: string,
  subTasks: SubTask[],
  _teamId: string,
  _projectId?: string
): Promise<{ success: boolean; createdIds: string[]; error?: string }> {
  // This function needs to call Linear MCP directly,
  // so autonomousRunner uses mcp__linear-server__create_issue
  // Here we only prepare data

  const createdIds: string[] = [];

  // Note: actual Linear API calls are made in autonomousRunner
  console.log(`[Planner] Prepared ${subTasks.length} sub-issues for ${parentIssueId}`);

  return { success: true, createdIds };
}

/**
 * Estimate issue duration (heuristic)
 */
export function estimateTaskDuration(task: TaskItem): number {
  const title = task.title.toLowerCase();
  const desc = (task.description || '').toLowerCase();
  const combined = `${title} ${desc}`;

  // Keyword-based estimation
  let estimate = 30; // Default 30 min

  // Complexity increasing factors
  if (combined.includes('optimization') || combined.includes('optimize')) estimate += 30;
  if (combined.includes('refactor') || combined.includes('refactoring')) estimate += 20;
  if (combined.includes('test') || combined.includes('testing')) estimate += 15;
  if (combined.includes('migration') || combined.includes('migrate')) estimate += 40;
  if (combined.includes('all') || combined.includes('entire') || combined.includes('every')) estimate += 30;
  if (combined.includes('ci/cd') || combined.includes('pipeline')) estimate += 25;
  if (combined.includes('frontend') && combined.includes('backend')) estimate += 40;
  if (combined.includes('playwright') || combined.includes('e2e')) estimate += 30;

  // Complexity decreasing factors
  if (combined.includes('bug') || combined.includes('fix') || combined.includes('bugfix')) estimate -= 10;
  if (combined.includes('docs') || combined.includes('documentation')) estimate -= 15;
  if (combined.includes('simple') || combined.includes('trivial')) estimate -= 15;

  return Math.max(10, estimate);
}

/**
 * Determine whether decomposition is needed.
 * Always returns true when enableDecomposition is set — the LLM planner decides.
 * The pre-LLM heuristic only applies if explicitly requested via checkHeuristic flag.
 */
export function needsDecomposition(task: TaskItem, maxMinutes: number = 30, checkHeuristic: boolean = false): boolean {
  if (checkHeuristic) {
    const estimated = estimateTaskDuration(task);
    return estimated > maxMinutes;
  }
  // Always run planner for all tasks; planner itself will return needsDecomposition:false for small tasks
  return true;
}

// Formatting

/**
 * Format Planner result as a Discord message
 */
export function formatPlannerResult(result: PlannerResult): string {
  const lines: string[] = [];

  if (!result.success) {
    lines.push(`❌ ${t('agents.planner.report.analysisFailed')}`);
    lines.push(`${t('agents.planner.report.reason', { text: result.error || 'Unknown error' })}`);
    return lines.join('\n');
  }

  if (!result.needsDecomposition) {
    lines.push(`✅ ${t('agents.planner.report.noDecomposition')}`);
    lines.push(t('agents.planner.report.reason', { text: result.reason || '' }));
    lines.push(t('agents.planner.report.estimatedTime', { n: result.totalEstimatedMinutes }));
    return lines.join('\n');
  }

  lines.push(`📋 ${t('agents.planner.report.decompositionDone')}`);
  lines.push(t('agents.planner.report.original', { text: result.originalIssue }));
  lines.push(t('agents.planner.report.reason', { text: result.reason || '' }));
  lines.push('');
  lines.push(t('agents.planner.report.subTasksHeader', { count: result.subTasks.length, totalMinutes: result.totalEstimatedMinutes }));

  for (let i = 0; i < result.subTasks.length; i++) {
    const st = result.subTasks[i];
    const deps = st.dependencies?.length ? t('agents.planner.report.dependency', { deps: st.dependencies.join(', ') }) : '';
    lines.push(`${i + 1}. ${st.title} (~${st.estimatedMinutes}min)${deps}`);
  }

  return lines.join('\n');
}
