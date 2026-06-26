// ============================================
// OpenSwarm - Worker Agent
// Task execution agent (CLI adapter based)
// ============================================

import type { WorkerResult } from './agentPair.js';
import * as gitTracker from '../support/gitTracker.js';
import { t, getPrompts } from '../locale/index.js';
import type { WorkerContext } from '../locale/types.js';
import type { AdapterName, ProcessContext } from '../adapters/types.js';
import { getAdapter, getDefaultAdapterName, spawnCli } from '../adapters/index.js';
import { expandPath } from '../core/config.js';
import { RateLimitError } from '../adapters/rateLimitError.js';

// Types

export interface WorkerOptions {
  taskTitle: string;
  taskDescription: string;
  projectPath: string;
  previousFeedback?: string;   // Previous feedback from Reviewer (for revisions)
  timeoutMs?: number;
  model?: string;              // Model ID (default: adapter default)
  maxTurns?: number;           // Max agentic turns per CLI invocation
  adapterName?: AdapterName;
  /** Reasoning effort from a jobProfile (codex-responses: low|medium|high). When set, reasoning is enabled at this effort. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  issueIdentifier?: string;    // Linear issue ID (e.g., INT-123)
  projectName?: string;        // Linear project name
  onLog?: (line: string) => void;  // Callback for stdout streaming
  processContext?: ProcessContext;
  /** 코드 컨텍스트 (impact analysis + registry briefs) */
  workerContext?: WorkerContext;
  /** no-edit 종료 가드 횟수 — 수정 필수 작업에서 모델이 edit 없이 끝내면 N회 되밂 */
  nudgeMaxOnNoEdit?: number;
  /** Verification-harness file protection — listed files reject edit/write */
  protectedFiles?: string[];
  /** bash tool timeout in ms — raise for slow verification such as docker-based tests */
  bashTimeoutMs?: number;
  /** Expose web_fetch + web_search tools (default true). Set false for SWE-bench integrity. */
  webTools?: boolean;
  /** Abort the run + in-flight adapter call (pipeline cancel / project disable). */
  signal?: AbortSignal;
}

// Prompts

/**
 * Build Worker prompt using locale templates
 */
function buildWorkerPrompt(options: WorkerOptions): string {
  return getPrompts().buildWorkerPrompt({
    taskTitle: options.taskTitle,
    taskDescription: options.taskDescription,
    previousFeedback: options.previousFeedback,
    context: options.workerContext,
  });
}

function getWorkerFallbackAdapters(primary: AdapterName): AdapterName[] {
  const fallbackMap: Partial<Record<AdapterName, AdapterName>> = {
    codex: 'claude',
    'codex-responses': 'claude',
    claude: 'codex',
  };

  const fallback = fallbackMap[primary];
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

export function isProviderQuotaError(message?: string): boolean {
  if (!message) return false;
  const text = message.toLowerCase();

  const hasQuotaSignal = /\bquota\b/.test(text);
  const hasRateLimit = /\brate[-\s]?limit\b/.test(text);
  const hasTooManyRequests = /\btoo many requests\b/.test(text);
  const hasInsufficientQuota = /\binsufficient[_-]?quota\b/.test(text);
  const hasUsageLimit = /\busage\b.*\blimit\b/.test(text) || /\blimit\b.*\busage\b/.test(text);
  const hasExceededPair = /\bexceeded\b/.test(text) && /\b(quota|limit|usage)\b/.test(text);
  const has429 = /\b429\b/.test(text) && (/\brequest\b/.test(text) || /rate/.test(text));
  // "billing" alone is NOT a quota signal — a task whose title/summary mentions
  // billing/invoices/payments (e.g. a payment-feature issue) would otherwise be
  // misread as a quota failure and trigger a spurious adapter fallback. Only treat
  // billing as a quota signal when paired with an actual quota/limit word. (INT-1927)
  const hasBilling = /\bbilling\b/.test(text) && /\b(quota|limit|exceeded|insufficient|suspended)\b/.test(text);

  return (
    hasQuotaSignal ||
    hasRateLimit ||
    hasTooManyRequests ||
    hasInsufficientQuota ||
    hasUsageLimit ||
    hasExceededPair ||
    has429 ||
    hasBilling
  );
}

function isWorkerQuotaFailure(result: WorkerResult): boolean {
  return (
    isProviderQuotaError(result.error) ||
    isProviderQuotaError(result.summary) ||
    isProviderQuotaError(result.haltReason)
  );
}

// Worker Execution

/**
 * Run Worker agent
 * Integrates Git-based file change tracking (Aider style)
 */
export async function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  const prompt = buildWorkerPrompt(options);
  const cwd = expandPath(options.projectPath);
  const primaryAdapterName = options.adapterName ?? getDefaultAdapterName();
  const adaptersToTry = [...new Set(getWorkerFallbackAdapters(primaryAdapterName))];

  // Git snapshot (pre-work state)
  let snapshotHash = '';
  const isGitRepo = await gitTracker.isGitRepo(cwd);
  if (isGitRepo) {
    snapshotHash = await gitTracker.takeSnapshot(cwd);
    console.log(`[Worker] Git snapshot: ${snapshotHash.slice(0, 8)}`);
  }

  const runAttempt = async (
    adapterName: AdapterName,
    isFallbackAttempt: boolean
  ): Promise<WorkerResult> => {
    const adapter = getAdapter(adapterName);
    // Keep user model on primary attempt; when switching adapters, let provider
    // default resolve the model to avoid provider/model mismatch.
    const model = isFallbackAttempt ? undefined : options.model;

    const raw = await spawnCli(adapter, {
      prompt,
      cwd,
      timeoutMs: options.timeoutMs,
      model,
      maxTurns: options.maxTurns,
      onLog: options.onLog,
      processContext: options.processContext,
      systemPrompt: getPrompts().systemPrompt,
      // Worker is a mechanical execution role — file edits, not deep reasoning.
      // Disable reasoning tokens to cut cost/latency (no-op on non-thinking models).
      // BUT when a jobProfile sets an effort (e.g. heavy tasks), reason at that effort.
      disableReasoning: !options.reasoningEffort,
      reasoningEffort: options.reasoningEffort,
      nudgeMaxOnNoEdit: options.nudgeMaxOnNoEdit,
      protectedFiles: options.protectedFiles,
      bashTimeoutMs: options.bashTimeoutMs,
      webTools: options.webTools,
      signal: options.signal,
    });

    // Parse result via adapter
    const parsedResult = adapter.parseWorkerOutput(raw);

    // Git diff is the source of truth for "did real work happen" — independent of
    // whether the model emitted a well-formed JSON success block. LLMs are weak at
    // structured output, so we never let a missing/malformed JSON block alone mark
    // a task as failed when the working tree actually changed (VEGA-style: real
    // signal over self-report).
    if (isGitRepo && snapshotHash) {
      const gitChangedFiles = await gitTracker.getChangedFilesSinceSnapshot(cwd, snapshotHash);

      if (gitChangedFiles.length > 0) {
        console.log(`[Worker] Git detected changes: ${gitChangedFiles.join(', ')}`);

        // Merge with LLM-reported files (Git results take priority)
        const mergedFiles = new Set([
          ...gitChangedFiles,
          ...parsedResult.filesChanged,
        ]);
        parsedResult.filesChanged = Array.from(mergedFiles);

        // Real file changes + no explicit error signal → treat as success even if
        // the model never produced a JSON block. Only an explicit error/halt in the
        // output should keep success=false here.
        if (!parsedResult.success && !parsedResult.error && !parsedResult.haltReason) {
          console.log('[Worker] Promoting to success: git changes present, no error signal');
          parsedResult.success = true;
          if (!parsedResult.summary || parsedResult.summary === t('common.fallback.noSummary')) {
            parsedResult.summary = `Modified ${gitChangedFiles.length} file(s): ${gitChangedFiles.slice(0, 5).join(', ')}`;
          }
        }
      } else if (parsedResult.filesChanged.length === 0) {
        console.log('[Worker] No file changes detected by Git or LLM');
      }
    }

    return parsedResult;
  };

  for (let i = 0; i < adaptersToTry.length; i += 1) {
    const adapterName = adaptersToTry[i];
    const isFallbackAttempt = i > 0;

    try {
      if (isFallbackAttempt) {
        const prev = adaptersToTry[i - 1];
        const logLine = `[Worker] Usage limit on ${prev}, fallback to ${adapterName}`;
        console.log(logLine);
        options.onLog?.(logLine);
      }

      const result = await runAttempt(adapterName, isFallbackAttempt);
      if (!isFallbackAttempt && isWorkerQuotaFailure(result) && adaptersToTry.length > 1) {
        continue;
      }
      if (isFallbackAttempt && result.error) {
        result.error = `[${adapterName}] ${result.error}`;
      }
      return result;
    } catch (error) {
      // A 429/usage-limit must STOP the run and propagate so the scheduler can
      // pause — never fall back to another adapter (it shares the same quota
      // window) and never get swallowed as a generic worker failure. (INT-1906)
      if (error instanceof RateLimitError) throw error;

      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Worker] Execution failed (${adapterName}): ${errMsg}`);
      if (error instanceof Error && error.message.includes('code')) {
        console.error('[Worker] CLI exited with non-zero code — check adapter auth and permissions');
      }

      if (!isFallbackAttempt && isProviderQuotaError(errMsg) && adaptersToTry.length > 1) {
        continue;
      }

      return {
        success: false,
        summary: isFallbackAttempt ? `[${adapterName}] Worker execution failed` : 'Worker execution failed',
        filesChanged: [],
        commands: [],
        output: '',
        error: isFallbackAttempt ? `[${adapterName}] ${errMsg}` : errMsg,
      };
    }
  }

  return {
    success: false,
    summary: 'Worker execution failed',
    filesChanged: [],
    commands: [],
    output: '',
    error: 'Worker execution failed for all configured providers',
  };
}

// Formatting

/**
 * Format Worker result as a Discord message
 */
export function formatWorkReport(result: WorkerResult, context?: {
  issueIdentifier?: string;
  projectName?: string;
  projectPath?: string;
}): string {
  const lines: string[] = [];

  // Project/issue context header
  if (context?.projectName || context?.issueIdentifier || context?.projectPath) {
    const parts: string[] = [];
    // projectName fallback: extract from projectPath if not provided
    const displayName = context.projectName
      || (context.projectPath ? context.projectPath.split('/').pop() || '' : '');
    if (displayName) parts.push(`📁 ${displayName}`);
    if (context.issueIdentifier) parts.push(`🔖 ${context.issueIdentifier}`);
    if (context.projectPath) parts.push(`\`${context.projectPath.split('/').slice(-2).join('/')}\``);
    if (parts.length > 0) {
      lines.push(parts.join(' | '));
      lines.push('');
    }
  }

  lines.push(result.success
    ? t('agents.worker.report.completed')
    : t('agents.worker.report.failed'));
  lines.push('');
  lines.push(t('agents.worker.report.summary', { text: result.summary }));

  if (result.filesChanged.length > 0) {
    const files = result.filesChanged;
    const fileList = files.length <= 15
      ? files.join(', ')
      : `${files.slice(0, 15).join(', ')} ${t('common.moreItems', { n: files.length - 15 })}`;
    lines.push(t('agents.worker.report.filesChanged', { count: files.length, list: fileList }));
  }

  if (result.commands.length > 0) {
    const cmdList = result.commands.slice(0, 5).map((c) => `\`${c}\``).join(', ');
    lines.push(t('agents.worker.report.commands', { list: cmdList }));
  }

  if (result.error) {
    lines.push(t('agents.worker.report.error', { text: result.error }));
  }

  return lines.join('\n');
}
