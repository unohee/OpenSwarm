// ============================================
// OpenSwarm - Skill Documenter Agent
// /documents skill-based automatic documentation update agent
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

export interface SkillDocumenterOptions {
  taskTitle: string;
  taskDescription: string;
  workerResult: WorkerResult;
  projectPath: string;
  timeoutMs?: number;
  model?: string;
}

export interface SkillDocumenterResult {
  success: boolean;
  updatedFiles: string[];
  summary: string;
  error?: string;
  costInfo?: CostInfo;
}

// ============================================
// Prompts
// ============================================

function buildSkillDocumenterPrompt(options: SkillDocumenterOptions): string {
  const workerReport = `
- **Success:** ${options.workerResult.success}
- **Summary:** ${options.workerResult.summary}
- **Files Changed:** ${options.workerResult.filesChanged.join(', ') || '(none)'}
- **Commands:** ${options.workerResult.commands.join(', ') || '(none)'}
`;

  return `/documents

## Task Context
- **Task:** ${options.taskTitle}
- **Description:** ${options.taskDescription}

## Worker's Changes
${workerReport}

Update the project documentation to reflect the changes from the above task.
After the documentation update is complete, output the result in the following JSON format:

\`\`\`json
{
  "success": true,
  "updatedFiles": ["CLAUDE.md", "docs/architecture.md"],
  "summary": "Added new module description to architecture docs"
}
\`\`\`

When there is nothing to update:
\`\`\`json
{
  "success": true,
  "updatedFiles": [],
  "summary": "No documentation update needed (minor change)"
}
\`\`\`

On failure:
\`\`\`json
{
  "success": false,
  "updatedFiles": [],
  "summary": "Documentation update failed",
  "error": "Detailed error message"
}
\`\`\`
`;
}

// ============================================
// Skill Documenter Execution
// ============================================

export async function runSkillDocumenter(options: SkillDocumenterOptions): Promise<SkillDocumenterResult> {
  const prompt = buildSkillDocumenterPrompt(options);
  const promptFile = `/tmp/skill-documenter-prompt-${Date.now()}.txt`;

  try {
    await fs.writeFile(promptFile, prompt);
    const cwd = expandPath(options.projectPath);
    const output = await runClaudeCli(promptFile, cwd, options.timeoutMs, options.model);
    return parseSkillDocumenterOutput(output);
  } catch (error) {
    return {
      success: false,
      updatedFiles: [],
      summary: 'Skill Documenter execution failed',
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
  timeoutMs: number = 120000,
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
        reject(new Error(`SkillDocumenter timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0 && code !== null) {
        console.error('[SkillDocumenter] CLI error:', stderr.slice(0, 500));
        reject(new Error(`Claude CLI failed with code ${code}`));
        return;
      }
      resolve(stdout);
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`SkillDocumenter spawn error: ${err.message}`));
    });
  });
}

// ============================================
// Output Parsing
// ============================================

function parseSkillDocumenterOutput(output: string): SkillDocumenterResult {
  try {
    const costInfo = extractCostFromStreamJson(output);
    if (costInfo) {
      console.log(`[SkillDocumenter] Cost: ${formatCost(costInfo)}`);
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
    console.error('[SkillDocumenter] Parse error:', error);
    return extractFromText(output);
  }
}

function extractResultJson(text: string): SkillDocumenterResult | null {
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

function normalizeResult(parsed: any): SkillDocumenterResult {
  return {
    success: Boolean(parsed.success),
    updatedFiles: Array.isArray(parsed.updatedFiles) ? parsed.updatedFiles : [],
    summary: parsed.summary || '(no summary)',
    error: parsed.error,
  };
}

function extractFromText(text: string): SkillDocumenterResult {
  const hasError = /error|fail|exception/i.test(text);
  const hasSuccess = /success|completed|updated|documented/i.test(text);

  const updatedFiles: string[] = [];
  const filePatterns = [
    /(?:updated?|modified?|created?|wrote?):\s*(.+\.(?:md|rst|txt))/gi,
    /(?:CLAUDE|AGENTS|README|docs?)\.md/gi,
  ];

  for (const pattern of filePatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      const file = m[1] || m[0];
      if (!updatedFiles.includes(file)) {
        updatedFiles.push(file);
      }
    }
  }

  return {
    success: !hasError || hasSuccess,
    updatedFiles: updatedFiles.slice(0, 10),
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

export function formatSkillDocReport(result: SkillDocumenterResult): string {
  const statusEmoji = result.success ? '📄' : '❌';
  const lines: string[] = [];

  lines.push(`${statusEmoji} **Skill Documenter Result: ${result.success ? 'Complete' : 'Failed'}**`);
  lines.push('');
  lines.push(`**Summary:** ${result.summary}`);

  if (result.updatedFiles.length > 0) {
    lines.push(`**Updated Files:** ${result.updatedFiles.join(', ')}`);
  } else {
    lines.push('**Updated Files:** (none)');
  }

  if (result.error) {
    lines.push(`**Error:** ${result.error}`);
  }

  return lines.join('\n');
}
