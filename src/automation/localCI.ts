// Local CI runner — replaces the GitHub Actions gate when Actions can't run (no cloud credits).
// Checks out the PR branch, detects the language, and runs the test/lint commands directly via
// the shell (no LLM, deterministic). prProcessor uses the result as the merge gate.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findProjectVenv } from '../adapters/tools.js';

const execFileAsync = promisify(execFile);

/**
 * Build the env for CI steps with the project's Python venv on PATH. Without this, `pytest`/`ruff`
 * resolve to system Python — which lacks the project's test deps (e.g. pytest-xdist), so a repo
 * pytest.ini with `addopts = -n auto` fails with "unrecognized arguments: -n" and the gate wrongly
 * blocks the PR. Mirrors the bash tool's venv resolution: repo-local .venv → OPENSWARM_PYTHON_VENV.
 */
function venvEnv(projectPath: string): NodeJS.ProcessEnv {
  const venv = findProjectVenv(projectPath) || process.env.OPENSWARM_PYTHON_VENV || '';
  if (!venv) return process.env;
  return { ...process.env, VIRTUAL_ENV: venv, PATH: `${join(venv, 'bin')}:${process.env.PATH ?? ''}` };
}

export interface LocalCIResult {
  /** true = all gate steps passed (or only missing-tool steps were skipped) */
  success: boolean;
  /** true = at least one real test/lint step actually ran */
  ran: boolean;
  /** human-readable log for the PR comment */
  output: string;
}

/** A gate step: its exit code decides pass/fail (lint/typecheck/test all exit non-zero on issues). */
interface Step { cmd: string; args: string[]; label: string }

export function detectSteps(projectPath: string): Step[] {
  const has = (f: string) => existsSync(join(projectPath, f));
  const isPython = has('pyproject.toml') || has('setup.py') || has('requirements.txt');
  const isNode = has('package.json');
  if (isPython) {
    return [
      { cmd: 'ruff', args: ['check', '.'], label: 'ruff' },
      { cmd: 'pytest', args: ['-q'], label: 'pytest' },
    ];
  }
  if (isNode) {
    return [
      { cmd: 'npx', args: ['tsc', '--noEmit'], label: 'tsc' },
      { cmd: 'npm', args: ['test'], label: 'npm test' },
    ];
  }
  return [];
}

export const isMissingTool = (s: string) => /command not found|ENOENT|not found|No such file/i.test(s);

/**
 * Check out `branch` in `projectPath` and run the detected CI steps. Missing tools (e.g. ruff not
 * installed) are skipped, not failed — only a tool that runs and exits non-zero counts as a CI
 * failure. Returns `ran: false` when the project language isn't recognized or checkout fails.
 */
export async function runLocalCI(projectPath: string, branch: string): Promise<LocalCIResult> {
  try {
    await execFileAsync('git', ['-C', projectPath, 'fetch', 'origin'], { timeout: 60_000 });
    await execFileAsync('git', ['-C', projectPath, 'reset', '--hard', 'HEAD'], { timeout: 30_000 }).catch(() => {});
    await execFileAsync('git', ['-C', projectPath, 'checkout', branch], { timeout: 60_000 });
    await execFileAsync('git', ['-C', projectPath, 'pull', 'origin', branch], { timeout: 60_000 }).catch(() => {});
  } catch (e) {
    return { success: false, ran: false, output: `checkout failed: ${(e as Error).message}` };
  }

  const steps = detectSteps(projectPath);
  if (steps.length === 0) {
    return { success: true, ran: false, output: 'no recognized project (python/node) — local CI skipped' };
  }

  let success = true;
  let ran = false;
  let output = '';
  const env = venvEnv(projectPath);
  for (const s of steps) {
    try {
      const r = await execFileAsync(s.cmd, s.args, { cwd: projectPath, timeout: 300_000, maxBuffer: 10 * 1024 * 1024, env });
      ran = true;
      output += `✓ ${s.label}\n${(r.stdout || '').slice(-600)}\n`;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string; code?: string };
      const blob = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`;
      if (isMissingTool(blob)) {
        output += `⊘ ${s.label}: tool not installed — skipped\n`;
        continue; // a missing tool is not a test failure
      }
      ran = true;
      success = false;
      output += `✗ ${s.label}\n${blob.slice(-1000)}\n`;
    }
  }
  return { success, ran, output };
}
