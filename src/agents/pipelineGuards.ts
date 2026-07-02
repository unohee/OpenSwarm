// ============================================
// OpenSwarm - Pipeline Guards
// Quality gates and validation between worker/reviewer
// ============================================

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { WorkerResult } from './agentPair.js';
import type { PipelineGuardsConfig } from '../core/types.js';
import { getRegistryStore } from '../registry/sqliteStore.js';
import { scanFile as scanFileForBs } from '../registry/bsDetector.js';
import { getWorkingDiffDetail } from '../support/gitTracker.js';

const execFileAsync = promisify(execFile);

// Types

export interface GuardResult {
  passed: boolean;
  guard: string;
  issues: string[];
  blocking: boolean;
}

export interface GuardsRunResult {
  allPassed: boolean;
  results: GuardResult[];
  combinedIssues: string[];
}

// Uncertainty Detection Patterns

const UNCERTAINTY_PATTERNS = [
  'maybe', 'might', 'probably', 'perhaps',
  'workaround', 'hack', 'temporary fix', 'temp fix',
  'not sure', 'not certain', 'unclear',
  'i think', 'i believe', 'i assume',
  'could be', 'seems like', 'appears to',
  'not tested', 'untested', 'skip test',
  'todo', 'fixme', 'xxx',
];

// Fake Data Detection Patterns

const FAKE_DATA_PATTERNS = [
  /faker\./i,
  /\bnp\.random\b/,
  /Math\.random\(\)/,
  /lorem\s*ipsum/i,
  /test@test\.com/i,
  /foo@bar\.com/i,
  /mockData\b/i,
  /dummy\s*data/i,
  /placeholder\s*text/i,
  /sample\s*data/i,
];

// Conventional Commit Pattern

const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?!?:\s.+/;

// Branch Name Patterns

const VALID_BRANCH_PATTERNS = [
  /^swarm\/.+/,
  /^feature\/.+/,
  /^release\/v.+/,
  /^hotfix\/.+/,
  /^main$/,
  /^develop$/,
];

// Guard Functions

/**
 * Quality gate: run tsc --noEmit on TypeScript files or ruff check on Python files.
 * Blocking — failure causes a revise.
 */
async function runQualityGate(
  workerResult: WorkerResult,
  projectPath: string,
): Promise<GuardResult> {
  const guard = 'qualityGate';
  const issues: string[] = [];

  const tsFiles = workerResult.filesChanged.filter(f => f.endsWith('.ts') || f.endsWith('.tsx'));
  const pyFiles = workerResult.filesChanged.filter(f => f.endsWith('.py'));

  if (tsFiles.length > 0) {
    try {
      await execFileAsync('npx', ['tsc', '--noEmit'], {
        cwd: projectPath,
        timeout: 60_000,
      });
    } catch (err: unknown) {
      const execErr = err as { stderr?: string; stdout?: string };
      const stderr = execErr.stderr || execErr.stdout || String(err);
      issues.push(`TypeScript check failed: ${stderr.slice(0, 500)}`);
    }
  }

  if (pyFiles.length > 0) {
    try {
      await execFileAsync('ruff', ['check', ...pyFiles], {
        cwd: projectPath,
        timeout: 60_000,
      });
    } catch (err: unknown) {
      const execErr = err as { stderr?: string; stdout?: string };
      const stderr = execErr.stderr || execErr.stdout || String(err);
      issues.push(`Ruff check failed: ${stderr.slice(0, 500)}`);
    }
  }

  return { passed: issues.length === 0, guard, issues, blocking: true };
}

/**
 * Fake data guard: detect faker, random, mock data patterns in changed output.
 * Non-blocking — warning only.
 */
function runFakeDataGuard(workerResult: WorkerResult): GuardResult {
  const guard = 'fakeDataGuard';
  const issues: string[] = [];

  const textToScan = workerResult.output.slice(0, 5000);

  for (const pattern of FAKE_DATA_PATTERNS) {
    const match = textToScan.match(pattern);
    if (match) {
      issues.push(`Possible fake/mock data detected: "${match[0]}"`);
    }
  }

  return { passed: issues.length === 0, guard, issues, blocking: false };
}

/**
 * Conventional commit guard: validate commit message format.
 * Non-blocking — warning only.
 */
export function runConventionalCommitGuard(commitMessage: string): GuardResult {
  const guard = 'conventionalCommits';
  const issues: string[] = [];

  const firstLine = commitMessage.split('\n')[0].trim();
  if (!CONVENTIONAL_COMMIT_RE.test(firstLine)) {
    issues.push(
      `Commit message does not follow conventional format: "${firstLine.slice(0, 80)}". ` +
      `Expected: type(scope): description`,
    );
  }

  return { passed: issues.length === 0, guard, issues, blocking: false };
}

/**
 * Branch name guard: validate branch naming convention.
 * Non-blocking — warning only.
 */
async function runBranchNameGuard(projectPath: string): Promise<GuardResult> {
  const guard = 'branchValidation';
  const issues: string[] = [];

  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: projectPath,
      timeout: 5_000,
    });
    const branch = stdout.trim();
    if (branch && !VALID_BRANCH_PATTERNS.some(p => p.test(branch))) {
      issues.push(
        `Branch "${branch}" does not match allowed patterns: swarm/*, feature/*, release/v*, hotfix/*, main, develop`,
      );
    }
  } catch {
    // git not available or not in repo — skip silently
  }

  return { passed: issues.length === 0, guard, issues, blocking: false };
}

/**
 * Uncertainty detection: scan worker output for uncertainty phrases.
 * Non-blocking — populates uncertaintySignals on WorkerResult.
 */
function runUncertaintyDetection(workerResult: WorkerResult): GuardResult {
  const guard = 'uncertaintyDetection';
  const issues: string[] = [];

  const textToScan = (
    workerResult.summary + ' ' + workerResult.output.slice(0, 2000)
  ).toLowerCase();

  const detected: string[] = [];
  for (const phrase of UNCERTAINTY_PATTERNS) {
    if (textToScan.includes(phrase)) {
      detected.push(phrase);
    }
  }

  if (detected.length > 0) {
    issues.push(`Uncertainty signals detected: ${detected.join(', ')}`);
    // Populate on the result for downstream use
    workerResult.uncertaintySignals = detected;
  }

  return { passed: issues.length === 0, guard, issues, blocking: false };
}

/**
 * Registry check: scan changed files against code registry.
 * Non-blocking — warns about deprecated/broken entities being modified,
 * untested entities being added, or active warnings on touched code.
 */
function runRegistryCheck(workerResult: WorkerResult): GuardResult {
  const guard = 'registryCheck';
  const issues: string[] = [];

  try {
    const store = getRegistryStore();

    for (const filePath of workerResult.filesChanged) {
      const brief = store.fileBrief(filePath);
      if (brief.entities.length === 0) continue;

      // deprecated 엔티티가 있는 파일 수정 시 경고
      const deprecated = brief.entities.filter(e => e.status === 'deprecated');
      if (deprecated.length > 0) {
        issues.push(
          `[${filePath}] ${deprecated.length} deprecated entity modified: ` +
          deprecated.map(e => `${e.name}${e.deprecatedReason ? ` (${e.deprecatedReason})` : ''}`).join(', ')
        );
      }

      // broken 엔티티가 있는 파일 수정 시 경고
      const broken = brief.entities.filter(e => e.status === 'broken');
      if (broken.length > 0) {
        issues.push(
          `[${filePath}] ${broken.length} broken entity: ${broken.map(e => e.name).join(', ')}`
        );
      }

      // 미해결 critical/error 경고가 있는 엔티티
      const withCriticalWarnings = brief.entities.filter(e =>
        e.warnings.some(w => !w.resolved && (w.severity === 'critical' || w.severity === 'error'))
      );
      if (withCriticalWarnings.length > 0) {
        for (const e of withCriticalWarnings) {
          const criticals = e.warnings.filter(w => !w.resolved && (w.severity === 'critical' || w.severity === 'error'));
          issues.push(
            `[${filePath}] ${e.name}: ${criticals.map(w => `${w.severity}/${w.category}: ${w.message}`).join('; ')}`
          );
        }
      }

      // high-risk + untested 조합 경고
      const riskyUntested = brief.entities.filter(
        e => e.riskLevel === 'high' && !e.hasTests && e.status === 'active'
      );
      if (riskyUntested.length > 0) {
        issues.push(
          `[${filePath}] ${riskyUntested.length} high-risk untested: ${riskyUntested.map(e => e.name).join(', ')}`
        );
      }
    }
  } catch (err) {
    // 레지스트리 DB가 없거나 접근 불가 시 무시
    console.warn('[Guard:registryCheck] Registry unavailable:', err);
  }

  return { passed: issues.length === 0, guard, issues, blocking: false };
}

/**
 * BS Detector guard: scan changed files for BS patterns in actual source code.
 * CRITICAL BS → blocking. WARNING/MINOR → non-blocking.
 */
async function runBsDetectorGuard(
  workerResult: WorkerResult,
  projectPath: string,
): Promise<GuardResult> {
  const guard = 'bsDetector';
  const issues: string[] = [];
  let hasCritical = false;

  try {
    const { join } = await import('node:path');
    for (const filePath of workerResult.filesChanged) {
      const fullPath = join(projectPath, filePath);
      const bsIssues = await scanFileForBs(fullPath);

      for (const bs of bsIssues) {
        const prefix = bs.severity === 'critical' ? 'CRITICAL' : bs.severity === 'warning' ? 'WARNING' : 'MINOR';
        issues.push(`[${prefix}] ${filePath}:${bs.line} — ${bs.message} (${bs.matchedText})`);
        if (bs.severity === 'critical') hasCritical = true;
      }
    }
  } catch (err) {
    console.warn('[Guard:bsDetector] Error:', err);
  }

  return { passed: issues.length === 0, guard, issues, blocking: hasCritical };
}

const SOURCE_FILE_RE = /\.(ts|tsx|js|jsx|py)$/;
const TEST_FILE_RE = /\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$/;
const DEPENDENCY_FAILURE_RE =
  /\b(ModuleNotFoundError|ImportError|Cannot find module|ERR_MODULE_NOT_FOUND|No module named|PackageNotFoundError|missing dependency|not installed)\b/i;
const VERSION_SPOOF_RE =
  /(^|\n)\s*(?:export\s+const\s+)?__version__\s*[:=]/;
const PACKAGE_SCAFFOLD_RE =
  /(^|\/)(package\.json|pyproject\.toml|setup\.py|setup\.cfg)$/;

async function getAddedLinesForFile(projectPath: string, filePath: string, isNew: boolean): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--unified=0', 'HEAD', '--', filePath],
      { cwd: projectPath, timeout: 10_000 },
    );
    const added = stdout
      .split('\n')
      .filter(line => line.startsWith('+') && !line.startsWith('+++'))
      .map(line => line.slice(1))
      .join('\n');
    if (added) return added;
  } catch {
    // Fall through to untracked-new handling below.
  }

  if (!isNew) return '';
  try {
    return await readFile(join(projectPath, filePath), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Dead-module guard (INT-2388 defect #5): a newly-added source module that
 * nothing imports/calls is dead scaffolding — it merges but never runs. For
 * each new source file, git-grep the codebase (working tree + untracked) for
 * its module basename; if only the file itself (or its own test) references it,
 * flag it. Non-blocking — an entry point wired via a dynamic/string import is a
 * legitimate exception the reviewer can clear.
 */
async function runDeadModuleGuard(projectPath: string): Promise<GuardResult> {
  const guard = 'deadModule';
  const issues: string[] = [];

  try {
    const details = await getWorkingDiffDetail(projectPath);
    const newSources = details.filter(
      d => d.isNew && SOURCE_FILE_RE.test(d.file) && !TEST_FILE_RE.test(d.file) && !d.file.endsWith('.d.ts'),
    );

    for (const d of newSources) {
      const base = (d.file.split('/').pop() ?? '').replace(SOURCE_FILE_RE, '');
      // Skip too-short/too-generic names (index, app, types…) — grep noise makes
      // the "no importer" signal meaningless, and a false "wired" is the safe side.
      if (base.length < 3 || ['index', 'main', 'types', 'utils', 'config', 'app'].includes(base)) continue;

      let referenced = false;
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['grep', '-l', '-F', '--untracked', '-e', base, '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.py'],
          { cwd: projectPath, timeout: 15_000 },
        );
        referenced = stdout
          .split('\n')
          .filter(Boolean)
          .some(f => {
            if (f === d.file) return false; // the file referencing itself doesn't count
            const fb = f.split('/').pop() ?? '';
            // its own test (base.test.ts / test_base.py) doesn't count as wiring
            if (fb.startsWith(`${base}.test`) || fb.startsWith(`${base}.spec`)) return false;
            if (fb === `test_${base}.py` || fb === `${base}_test.py`) return false;
            return true;
          });
      } catch {
        // git grep exits non-zero when there are zero matches → not referenced
        referenced = false;
      }

      if (!referenced) {
        issues.push(
          `[${d.file}] new module has no importer/caller — dead scaffolding? Wire it into the system or confirm it's an entry point.`,
        );
      }
    }
  } catch (err) {
    console.warn('[Guard:deadModule] Error:', err);
  }

  return { passed: issues.length === 0, guard, issues, blocking: false };
}

/**
 * Dependency anti-pattern guard (INT-2388 defect #1): if the worker reports an
 * import/package failure, don't allow the fix to become "recreate the missing
 * package" or "spoof its version". This is intentionally narrow and blocking:
 * it fires only when a dependency-failure signal is paired with package-identity
 * code or a new package scaffold in the diff.
 */
async function runDependencyAntiPatternGuard(
  workerResult: WorkerResult,
  projectPath: string,
): Promise<GuardResult> {
  const guard = 'dependencyAntiPattern';
  const issues: string[] = [];
  const reportText = `${workerResult.summary}\n${workerResult.output.slice(0, 8000)}\n${workerResult.error ?? ''}`;

  if (!DEPENDENCY_FAILURE_RE.test(reportText)) {
    return { passed: true, guard, issues, blocking: true };
  }

  try {
    const details = await getWorkingDiffDetail(projectPath);

    for (const d of details) {
      if (d.isNew && PACKAGE_SCAFFOLD_RE.test(d.file)) {
        issues.push(
          `[${d.file}] dependency/import failure was reported, but the diff adds package scaffold. Fix the environment or document the blocker instead of recreating a third-party package.`,
        );
      }

      if (!SOURCE_FILE_RE.test(d.file) || TEST_FILE_RE.test(d.file)) continue;

      const addedLines = await getAddedLinesForFile(projectPath, d.file, d.isNew);
      if (VERSION_SPOOF_RE.test(addedLines)) {
        issues.push(
          `[${d.file}] dependency/import failure was reported, but the diff defines __version__. Do not spoof package identity/version constants for code you do not own.`,
        );
      }
    }
  } catch (err) {
    console.warn('[Guard:dependencyAntiPattern] Error:', err);
  }

  return { passed: issues.length === 0, guard, issues, blocking: true };
}

/**
 * Reformat/scope guard (INT-2388 defect #6): flag reformat-only files (whose
 * diff vanishes under `git diff -w`) and unusually large diffs. Both inflate
 * cross-PR conflict surface and hide the real change. Non-blocking — advisory.
 */
async function runReformatScopeGuard(projectPath: string): Promise<GuardResult> {
  const guard = 'reformatScope';
  const issues: string[] = [];
  const LARGE_DIFF_LINES = 1200;

  try {
    const details = await getWorkingDiffDetail(projectPath);

    for (const d of details.filter(d => d.whitespaceOnly)) {
      issues.push(
        `[${d.file}] reformat-only change (no semantic diff under -w) — move formatting to a separate commit to keep the PR scoped.`,
      );
    }

    // Sum of tracked-change lines. Brand-new files register as 0 added here
    // (numstat only counts tracked diffs) and are covered by the dead-module
    // guard instead — so this measures churn on existing code, where scope
    // creep and reformat noise actually hide.
    const totalChanged = details.reduce((sum, d) => sum + d.added + d.deleted, 0);
    if (totalChanged > LARGE_DIFF_LINES) {
      issues.push(
        `Large diff: ${totalChanged} changed lines across ${details.length} files — verify every change is task-scoped (watch for scope creep).`,
      );
    }
  } catch (err) {
    console.warn('[Guard:reformatScope] Error:', err);
  }

  return { passed: issues.length === 0, guard, issues, blocking: false };
}

// Guard Runner

/**
 * Run all enabled guards on a worker result.
 */
export async function runGuards(
  workerResult: WorkerResult,
  projectPath: string,
  config: Partial<PipelineGuardsConfig>,
): Promise<GuardsRunResult> {
  const results: GuardResult[] = [];

  if (config.qualityGate) {
    results.push(await runQualityGate(workerResult, projectPath));
  }

  if (config.fakeDataGuard) {
    results.push(runFakeDataGuard(workerResult));
  }

  if (config.branchValidation) {
    results.push(await runBranchNameGuard(projectPath));
  }

  if (config.uncertaintyDetection) {
    results.push(runUncertaintyDetection(workerResult));
  }

  if (config.registryCheck) {
    results.push(runRegistryCheck(workerResult));
  }

  if (config.bsDetector) {
    results.push(await runBsDetectorGuard(workerResult, projectPath));
  }

  if (config.dependencyAntiPatternCheck) {
    results.push(await runDependencyAntiPatternGuard(workerResult, projectPath));
  }

  if (config.deadModuleCheck) {
    results.push(await runDeadModuleGuard(projectPath));
  }

  if (config.reformatCheck) {
    results.push(await runReformatScopeGuard(projectPath));
  }

  // conventionalCommits is checked separately (needs commit message)
  // haltToLinear is handled by the pipeline, not a guard function

  const combinedIssues = results.flatMap(r => r.issues);
  const allPassed = results.every(r => r.passed || !r.blocking);

  return { allPassed, results, combinedIssues };
}
