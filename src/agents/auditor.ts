// ============================================
// OpenSwarm - Auditor Agent
// /audit skill-based BS detection agent
// ============================================

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import type { WorkerResult } from './agentPair.js';
import { type CostInfo, extractCostFromStreamJson, formatCost } from '../support/costTracker.js';

function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return p.replace('~', homedir());
  }
  return p;
}

// ============================================
// Types
// ============================================

export interface AuditorOptions {
  taskTitle: string;
  taskDescription: string;
  workerResult: WorkerResult;
  projectPath: string;
  timeoutMs?: number;
  model?: string;
}

export interface AuditorResult {
  success: boolean;
  bsScore?: number;
  criticalCount: number;
  warningCount: number;
  minorCount: number;
  issues: string[];
  summary: string;
  error?: string;
  costInfo?: CostInfo;
}

// ============================================
// Prompts
// ============================================

function buildAuditorPrompt(options: AuditorOptions): string {
  const workerReport = `
- **Success:** ${options.workerResult.success}
- **Summary:** ${options.workerResult.summary}
- **Files Changed:** ${options.workerResult.filesChanged.join(', ') || '(none)'}
- **Commands:** ${options.workerResult.commands.join(', ') || '(none)'}
`;

  return `/audit

## Task Context
- **Task:** ${options.taskTitle}
- **Description:** ${options.taskDescription}

## Worker's Changes
${workerReport}

Perform an audit focusing on the files changed in the above task.
After the audit is complete, output the result in the following JSON format:

\`\`\`json
{
  "success": true,
  "bsScore": 2.1,
  "criticalCount": 0,
  "warningCount": 3,
  "minorCount": 5,
  "issues": ["src/foo.ts:42 - unused import"],
  "summary": "BS score 2.1/5.0, no CRITICAL issues"
}
\`\`\`

On failure:
\`\`\`json
{
  "success": false,
  "bsScore": 7.5,
  "criticalCount": 3,
  "warningCount": 5,
  "minorCount": 2,
  "issues": ["CRITICAL: src/bar.ts:10 - hardcoded secret"],
  "summary": "BS score 7.5/5.0 - CRITICAL issues found"
}
\`\`\`
`;
}

// ============================================
// Auditor Execution
// ============================================

export async function runAuditor(options: AuditorOptions): Promise<AuditorResult> {
  const prompt = buildAuditorPrompt(options);
  const promptFile = `/tmp/auditor-prompt-${Date.now()}.txt`;

  try {
    await fs.writeFile(promptFile, prompt);
    const cwd = expandPath(options.projectPath);
    const output = await runClaudeCli(promptFile, cwd, options.timeoutMs, options.model);
    return parseAuditorOutput(output);
  } catch (error) {
    return {
      success: false,
      criticalCount: 0,
      warningCount: 0,
      minorCount: 0,
      issues: [],
      summary: 'Auditor execution failed',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await fs.unlink(promptFile);
    } catch {
      // Ignore
    }
  }
}

async function runClaudeCli(
  promptFile: string,
  cwd: string,
  timeoutMs: number = 300000,
  model?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const modelFlag = model ? ` --model ${model}` : '';
    const cmd = `echo "" | claude -p "$(cat ${promptFile})" --output-format stream-json --permission-mode bypassPermissions${modelFlag}`;

    const proc = spawn(cmd, {
      shell: true,
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Auditor timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0 && code !== null) {
        console.error('[Auditor] CLI error:', stderr.slice(0, 500));
        reject(new Error(`Claude CLI failed with code ${code}`));
        return;
      }
      resolve(stdout);
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Auditor spawn error: ${err.message}`));
    });
  });
}

// ============================================
// Output Parsing
// ============================================

function parseAuditorOutput(output: string): AuditorResult {
  try {
    const costInfo = extractCostFromStreamJson(output);
    if (costInfo) {
      console.log(`[Auditor] Cost: ${formatCost(costInfo)}`);
    }

    // Extract result entry from NDJSON
    let resultText = '';
    for (const line of output.split('\n')) {
      try {
        const event = JSON.parse(line.trim());
        if (event.type === 'result' && event.result) {
          resultText = event.result;
          break;
        }
      } catch { /* skip non-JSON lines */ }
    }

    if (!resultText) {
      const result = extractFromText(output);
      result.costInfo = costInfo;
      return result;
    }

    const result = extractResultJson(resultText) || extractFromText(resultText);
    result.costInfo = costInfo;
    return result;
  } catch (error) {
    console.error('[Auditor] Parse error:', error);
    return extractFromText(output);
  }
}

function extractResultJson(text: string): AuditorResult | null {
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
      return normalizeResult(parsed);
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return normalizeResult(parsed);
  } catch {
    return null;
  }
}

function normalizeResult(parsed: any): AuditorResult {
  const bsScore = typeof parsed.bsScore === 'number' ? parsed.bsScore : undefined;
  return {
    success: bsScore !== undefined ? bsScore < 5.0 : Boolean(parsed.success),
    bsScore,
    criticalCount: typeof parsed.criticalCount === 'number' ? parsed.criticalCount : 0,
    warningCount: typeof parsed.warningCount === 'number' ? parsed.warningCount : 0,
    minorCount: typeof parsed.minorCount === 'number' ? parsed.minorCount : 0,
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    summary: parsed.summary || '(no summary)',
    error: parsed.error,
  };
}

function extractFromText(text: string): AuditorResult {
  const hasError = /error|fail|exception|critical/i.test(text);
  const hasSuccess = /success|pass|clean|no issues/i.test(text);

  // Extract BS score
  let bsScore: number | undefined;
  const bsMatch = text.match(/(?:bs|bullshit)\s*(?:score|index)[:\s]*(\d+(?:\.\d+)?)/i);
  if (bsMatch) {
    bsScore = parseFloat(bsMatch[1]);
  }

  // Extract issues
  const issues: string[] = [];
  const issuePattern = /(?:CRITICAL|WARNING|MINOR|issue)[:\s]+([^\n]+)/gi;
  const issueMatches = text.matchAll(issuePattern);
  for (const m of issueMatches) {
    if (!issues.includes(m[1].trim())) {
      issues.push(m[1].trim());
    }
  }

  return {
    success: !hasError || hasSuccess,
    bsScore,
    criticalCount: 0,
    warningCount: 0,
    minorCount: 0,
    issues: issues.slice(0, 20),
    summary: extractSummary(text),
    error: hasError ? extractErrorMessage(text) : undefined,
  };
}

function extractSummary(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 10);
  if (lines.length === 0) return '(no summary)';
  const summary = lines[0].trim();
  return summary.length > 200 ? summary.slice(0, 200) + '...' : summary;
}

function extractErrorMessage(text: string): string {
  const errorMatch = text.match(/(?:error|exception|failed?):\s*(.+)/i);
  if (errorMatch) return errorMatch[1].slice(0, 200);
  const lines = text.split('\n').filter((l) => /error|fail/i.test(l));
  if (lines.length > 0) return lines[0].slice(0, 200);
  return 'Unknown error';
}

// ============================================
// Formatting
// ============================================

export function formatAuditReport(result: AuditorResult): string {
  const statusEmoji = result.success ? '🔍' : '🚨';
  const lines: string[] = [];

  lines.push(`${statusEmoji} **Auditor Result: ${result.success ? 'PASS' : 'FAIL'}**`);
  lines.push('');

  if (result.bsScore !== undefined) {
    lines.push(`**BS Score:** ${result.bsScore.toFixed(1)}/5.0`);
  }

  lines.push(`**Critical:** ${result.criticalCount} | **Warning:** ${result.warningCount} | **Minor:** ${result.minorCount}`);
  lines.push(`**Summary:** ${result.summary}`);

  if (result.issues.length > 0) {
    lines.push('');
    lines.push('**Issues Found:**');
    for (const issue of result.issues.slice(0, 5)) {
      lines.push(`  - ${issue}`);
    }
    if (result.issues.length > 5) {
      lines.push(`  - ... +${result.issues.length - 5} more`);
    }
  }

  if (result.error) {
    lines.push(`**Error:** ${result.error}`);
  }

  return lines.join('\n');
}
