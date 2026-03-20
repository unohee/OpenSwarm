// ============================================
// OpenSwarm - Codex CLI Adapter
// Wraps `codex exec --json` for agent execution
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  WorkerResult,
  ReviewResult,
} from './types.js';
import { t } from '../locale/index.js';

const execFileAsync = promisify(execFile);

export class CodexCliAdapter implements CliAdapter {
  readonly name = 'codex';

  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: true,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: true,
    supportedSkills: [],
  };

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('which', ['codex']);
      return true;
    } catch {
      return false;
    }
  }

  buildCommand(options: CliRunOptions): { command: string; args: string[] } {
    const promptFile = options.prompt;
    const modelFlag = options.model ? ` -m ${shellEscape(options.model)}` : '';
    const cmd = `cat ${shellEscape(promptFile)} | codex exec --json --full-auto --skip-git-repo-check${modelFlag}`;
    return { command: cmd, args: [] };
  }

  parseStreamingChunk(
    chunk: string,
    onLog: (line: string) => void,
    buffer: string = '',
  ): string {
    const combined = buffer + chunk;
    const lines = combined.split('\n');
    const remainder = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      emitCodexStreamEvent(trimmed, onLog);
    }

    return remainder;
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    const resultText = extractCodexMessageText(raw.stdout);
    return extractWorkerResultJson(resultText) || extractWorkerFromText(resultText);
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    const resultText = extractCodexMessageText(raw.stdout);
    return extractReviewerResultJson(resultText) || extractReviewerFromText(resultText);
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function extractCodexMessageText(output: string): string {
  let lastMessage = '';

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed);
      if (
        event.type === 'item.completed' &&
        event.item?.type === 'agent_message' &&
        typeof event.item.text === 'string'
      ) {
        lastMessage = event.item.text;
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  return lastMessage || output;
}

function emitCodexStreamEvent(line: string, onLog: (line: string) => void): void {
  try {
    const event = JSON.parse(line);
    const eventType = typeof event.type === 'string' ? event.type : '';

    if (eventType === 'turn.started') {
      onLog('───');
      onLog('Codex turn started');
      return;
    }

    if (eventType === 'turn.completed') {
      onLog('Codex turn completed');
      return;
    }

    if (
      eventType === 'item.completed' &&
      event.item?.type === 'agent_message' &&
      typeof event.item.text === 'string'
    ) {
      emitCodexText(event.item.text, onLog);
      return;
    }

    if (eventType === 'item.completed' && event.item?.type === 'reasoning') {
      const summary = summarizeCodexReasoning(event.item);
      if (summary) onLog(`▸ ${summary}`);
      return;
    }

    if (eventType === 'error' && typeof event.message === 'string') {
      onLog(`ERROR: ${truncate(event.message, 300)}`);
    }
  } catch {
    // Ignore malformed or partial non-JSON lines.
  }
}

function emitCodexText(text: string, onLog: (line: string) => void): void {
  const lines = text.split('\n');
  let inCodeBlock = false;
  let prevWasEmpty = false;

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      onLog(inCodeBlock ? '┌─ code ─' : '└────────');
      prevWasEmpty = false;
      continue;
    }

    if (!trimmed) {
      if (!prevWasEmpty) {
        onLog('');
        prevWasEmpty = true;
      }
      continue;
    }
    prevWasEmpty = false;

    if (inCodeBlock) {
      onLog('│ ' + truncate(raw, 300));
      continue;
    }

    const headerMatch = trimmed.match(/^(#{1,4})\s+(.+)/);
    if (headerMatch) {
      onLog('');
      onLog('■ ' + headerMatch[2]);
      continue;
    }

    if (/^[-*]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      onLog('  ' + truncate(trimmed, 300));
      continue;
    }

    onLog(truncate(trimmed, 300));
  }
}

function summarizeCodexReasoning(item: Record<string, unknown>): string | null {
  if (typeof item.text === 'string' && item.text.trim()) {
    return truncate(item.text.trim(), 200);
  }

  if (typeof item.summary === 'string' && item.summary.trim()) {
    return truncate(item.summary.trim(), 200);
  }

  if (Array.isArray(item.summary)) {
    const text = item.summary
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && 'text' in entry && typeof entry.text === 'string') {
          return entry.text;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');

    return text ? truncate(text, 200) : null;
  }

  return null;
}

function extractWorkerResultJson(text: string): WorkerResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    const objMatch = text.match(/\{\s*"success"\s*:/);
    if (!objMatch) return null;

    const startIdx = objMatch.index!;
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
        success: Boolean(parsed.success),
        summary: parsed.summary || t('common.fallback.noSummary'),
        filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
        commands: Array.isArray(parsed.commands) ? parsed.commands : [],
        output: text,
        error: parsed.error,
        confidencePercent: typeof parsed.confidencePercent === 'number'
          ? parsed.confidencePercent : undefined,
        haltReason: parsed.haltReason || undefined,
      };
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return {
      success: Boolean(parsed.success),
      summary: parsed.summary || t('common.fallback.noSummary'),
      filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      output: text,
      error: parsed.error,
      confidencePercent: typeof parsed.confidencePercent === 'number'
        ? parsed.confidencePercent : undefined,
      haltReason: parsed.haltReason || undefined,
    };
  } catch {
    return null;
  }
}

function extractWorkerFromText(text: string): WorkerResult {
  const hasError = /error|fail|exception|cannot/i.test(text);
  const hasSuccess = /success|completed|done|finished/i.test(text);

  const filePatterns = [
    /(?:changed?|modified?|created?|updated?):\s*(.+\.(?:ts|js|py|json|yaml|yml|md))/gi,
    /(?:src|lib|test|tests)\/[\w/\-.]+\.(?:ts|js|py)/gi,
  ];

  const filesChanged: string[] = [];
  for (const pattern of filePatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      const file = m[1] || m[0];
      if (!filesChanged.includes(file)) {
        filesChanged.push(file);
      }
    }
  }

  const cmdPattern = /(?:`|\$)\s*((?:npm|pnpm|yarn|git|python|pytest|tsc|eslint|ruff|codex)\s+[^\n`]+)/gi;
  const commands: string[] = [];
  const cmdMatches = text.matchAll(cmdPattern);
  for (const m of cmdMatches) {
    if (!commands.includes(m[1])) {
      commands.push(m[1].trim());
    }
  }

  return {
    success: !hasError || hasSuccess,
    summary: extractSummary(text),
    filesChanged: filesChanged.slice(0, 10),
    commands: commands.slice(0, 10),
    output: text,
    error: hasError ? extractErrorMessage(text) : undefined,
  };
}

function extractSummary(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 10);
  if (lines.length === 0) return t('common.fallback.noSummary');
  const summary = lines[0].trim();
  return summary.length > 200 ? `${summary.slice(0, 200)}...` : summary;
}

function extractErrorMessage(text: string): string {
  const errorMatch = text.match(/(?:error|exception|failed?):\s*(.+)/i);
  if (errorMatch) {
    return errorMatch[1].slice(0, 200);
  }
  const lines = text.split('\n').filter((l) => /error|fail/i.test(l));
  if (lines.length > 0) {
    return lines[0].slice(0, 200);
  }
  return 'Unknown error';
}

function extractReviewerResultJson(text: string): ReviewResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    const objMatch = text.match(/\{\s*"decision"\s*:/);
    if (!objMatch) return null;

    const startIdx = objMatch.index!;
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
      return normalizeReviewResult(JSON.parse(text.slice(startIdx, endIdx)));
    } catch {
      return null;
    }
  }

  try {
    return normalizeReviewResult(JSON.parse(jsonMatch[1]));
  } catch {
    return null;
  }
}

function extractReviewerFromText(text: string): ReviewResult {
  const lower = text.toLowerCase();
  const decision = lower.includes('approve')
    ? 'approve'
    : lower.includes('reject')
      ? 'reject'
      : 'revise';

  return {
    decision,
    feedback: extractSummary(text),
    issues: extractBulletsAfter(text, /issues?:/i),
    suggestions: extractBulletsAfter(text, /suggestions?:/i),
  };
}

function normalizeReviewResult(parsed: Record<string, unknown>): ReviewResult {
  const decision = parsed.decision === 'approve' || parsed.decision === 'reject'
    ? parsed.decision
    : 'revise';

  return {
    decision,
    feedback: typeof parsed.feedback === 'string' ? parsed.feedback : t('common.fallback.noSummary'),
    issues: Array.isArray(parsed.issues)
      ? parsed.issues.filter((v): v is string => typeof v === 'string')
      : [],
    suggestions: Array.isArray(parsed.suggestions)
      ? parsed.suggestions.filter((v): v is string => typeof v === 'string')
      : [],
  };
}

function extractBulletsAfter(text: string, heading: RegExp): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return [];

  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (items.length > 0) break;
      continue;
    }
    if (!trimmed.startsWith('-') && !trimmed.startsWith('*')) {
      if (items.length > 0) break;
      continue;
    }
    items.push(trimmed.replace(/^[-*]\s*/, ''));
  }
  return items;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
