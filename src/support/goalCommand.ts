// ============================================
// OpenSwarm - Shared `/goal` orchestration (INT-1821 / S8)
// ============================================
//
// `/goal <goal>` routes by complexity, in one UI-agnostic place so every chat
// front-end behaves identically (mirrors planCommand.ts / PlanIO — INT-1441):
//
//   • simple goal  → pursue it autonomously in-session via the agentic chat loop
//                    (raised maxTurns), no decomposition, no daemon round-trip.
//   • complex goal → hand off to the `/plan` flow (decompose → approve → dispatch
//                    to the daemon loop) — runPlanCommand.
//
// The feat/v0.7.0 `chatBackend.judgeGoalComplexity/runGoalPipeline` pair never
// landed on main; this is the reconciled implementation. judgeGoalComplexity is
// a pure, testable heuristic so routing is deterministic (no extra model call).

import { runPlanCommand, type PlanIO, type PlanCommandOptions } from './planCommand.js';
import { callChatModel, loadDefaultProvider } from './chatSession.js';
import { getDefaultChatModel } from './chatBackend.js';
import type { AdapterName } from '../adapters/index.js';

export type GoalComplexity = 'simple' | 'complex';

/** Turn budget for autonomous simple-goal pursuit (higher than a normal chat turn). */
export const GOAL_PURSUIT_MAX_TURNS = 60;

// Signals that a goal is more than a single, local change. Each is intentionally
// coarse — the score threshold (2) is what decides, not any one keyword. Erring
// toward 'complex' is cheap (the planner may still say "no decomposition needed"
// and dispatch a single task); erring toward 'simple' risks one over-long pursuit.
const COMPLEX_KEYWORDS = [
  // English
  'refactor', 'migrate', 'migration', 'epic', 'redesign', 'rewrite', 'architecture',
  'entire', 'across', 'multiple', 'end-to-end', 'pipeline', 'integrate', 'overhaul',
  // Korean
  '전부', '모두', '전체', '리팩터', '마이그레이', '재설계', '아키텍처', '여러', '통합', '전반',
];

/**
 * Classify a goal as 'simple' (one focused change → pursue in-session) or
 * 'complex' (multiple steps/deliverables → decompose & dispatch). Pure heuristic
 * — deterministic and unit-tested, so /goal routing never needs a model call.
 */
export function judgeGoalComplexity(goal: string): GoalComplexity {
  const g = goal.trim();
  if (!g) return 'simple';
  const lower = g.toLowerCase();
  let score = 0;

  // Length: long asks tend to bundle work.
  const words = g.split(/\s+/).length;
  if (words > 25) score += 2;
  else if (words > 12) score += 1;

  // Multiple sentences / enumerations → multiple deliverables.
  const sentences = g.split(/[.!?。\n]+/).filter((s) => s.trim().length > 0).length;
  if (sentences >= 3) score += 2;
  else if (sentences === 2) score += 1;
  if (/(^|\s)(\d+\.|[-*])\s/m.test(g)) score += 2; // numbered or bulleted list

  // Conjunctions joining tasks.
  const conj =
    (lower.match(/\b(and|then|also|plus)\b/g) || []).length +
    (g.match(/그리고|또한|및|,|、/g) || []).length;
  if (conj >= 2) score += 2;
  else if (conj === 1) score += 1;

  // Heavyweight keywords.
  if (COMPLEX_KEYWORDS.some((k) => lower.includes(k))) score += 2;

  return score >= 2 ? 'complex' : 'simple';
}

/** Frame a goal as an autonomous task for the in-session agentic loop. */
export function buildGoalPursuitPrompt(goal: string): string {
  return [
    `Pursue this goal autonomously to completion, using the available tools:`,
    ``,
    goal.trim(),
    ``,
    `Work step by step, make the edits yourself, and verify the result. ` +
      `Stop when the goal is met or you are genuinely blocked (say why).`,
  ].join('\n');
}

export interface GoalCommandOptions extends PlanCommandOptions {
  /** Adapter for simple-goal pursuit (defaults to the configured provider). */
  provider?: AdapterName;
  /** Turn budget for pursuit (default GOAL_PURSUIT_MAX_TURNS). */
  maxTurns?: number;
  /** Abort the pursuit (Esc/Ctrl+C). */
  signal?: AbortSignal;
}

/** Injectable seams so routing is unit-testable without a model/daemon. */
export interface GoalCommandDeps {
  judge?: (goal: string) => GoalComplexity;
  /** Simple-goal pursuit. Front-ends override this to stream into their own UI. */
  pursue?: (goal: string, io: PlanIO, opts: GoalCommandOptions) => Promise<void>;
  /** Complex-goal handoff. Defaults to runPlanCommand. */
  plan?: (goal: string, io: PlanIO, opts: PlanCommandOptions) => Promise<void>;
}

/** Default simple-goal pursuit: run the agentic chat loop and print the result. */
async function defaultPursue(goal: string, io: PlanIO, opts: GoalCommandOptions): Promise<void> {
  const provider = opts.provider ?? loadDefaultProvider();
  const model = opts.model ?? getDefaultChatModel(provider);
  let out = '';
  await callChatModel(
    buildGoalPursuitPrompt(goal),
    provider,
    model,
    (text) => {
      out += text;
    },
    (line) => io.print(line),
    opts.maxTurns ?? GOAL_PURSUIT_MAX_TURNS,
    opts.signal,
    opts.projectPath, // pursue the goal in the target repo, not process.cwd() (INT-2005)
  );
  if (out.trim()) io.print(out.trim());
}

/**
 * Run the `/goal <goal>` flow: judge complexity, then route.
 * Returns the chosen complexity (handy for tests / callers).
 */
export async function runGoalCommand(
  goal: string,
  io: PlanIO,
  opts: GoalCommandOptions = {},
  deps: GoalCommandDeps = {},
): Promise<GoalComplexity> {
  const trimmed = goal.trim();
  if (!trimmed) {
    io.print('Usage: /goal <goal>');
    return 'simple';
  }

  const complexity = (deps.judge ?? judgeGoalComplexity)(trimmed);
  if (complexity === 'complex') {
    io.print(`🎯 Complex goal — decomposing & dispatching: ${trimmed}`);
    await (deps.plan ?? runPlanCommand)(trimmed, io, opts);
  } else {
    io.print(`🎯 Simple goal — pursuing autonomously: ${trimmed}`);
    await (deps.pursue ?? defaultPursue)(trimmed, io, opts);
  }
  return complexity;
}
