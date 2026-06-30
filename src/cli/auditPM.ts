// ============================================
// OpenSwarm - PM agent layer for `review --max --issues` (INT-2225)
// ============================================
//
// `review --max --issues` used to file one Linear sub-issue per audit area,
// which fanned a single audit into dozens or 100+ near-duplicate follow-ups.
// This module routes the deduped follow-ups through an LLM "PM" pass that groups
// related items by theme/module/root-cause into AT MOST 10 cohesive issues.
//
// The LLM call reuses the planner pattern (getAdapter → spawnCli → extract the
// ```json block → JSON.parse), so it inherits the same adapter wiring, timeout,
// and read-only agentic loop.

import type { RecommendedAction } from '../agents/agentPair.js';
import { getAdapter, spawnCli } from '../adapters/index.js';
import { getPrompts } from '../locale/index.js';

/** A cohesive issue synthesized from several related audit follow-ups. */
export interface SynthesizedIssue {
  /** `type(scope): what — why` */
  title: string;
  /** Linear priority: 1 (urgent) … 4 (low). */
  priority: number;
  /** Titles of the follow-ups grouped under this issue (for traceability). */
  items: string[];
  /** Markdown body (Background / Included follow-ups / Completion criteria). */
  description: string;
}

/** Below this many follow-ups, synthesis adds no value — the caller files them directly. */
const MIN_ACTIONS_TO_SYNTHESIZE = 3;
/** Hard cap on synthesized issues — the whole point is to stop the fan-out. */
const MAX_ISSUES = 10;

/**
 * Build the PM synthesis prompt. Lists the deduped follow-ups as
 * `- [type] title (location)` and asks for AT MOST 10 cohesive issues.
 */
export function buildSynthesisPrompt(actions: RecommendedAction[], repoName: string): string {
  const list = actions
    .map((a) => `- [${a.type}] ${a.title}${a.location ? ` (${a.location})` : ''}`)
    .join('\n');

  return [
    'You are a PM triaging a codebase audit.',
    '',
    `Repository: ${repoName}`,
    `Below are ${actions.length} deduped audit follow-ups discovered by reviewer agents:`,
    '',
    list,
    '',
    'Group RELATED follow-ups by theme, module, or root cause into a small set of',
    'cohesive, actionable issues. Rules:',
    '- Produce AT MOST 10 issues (maximum 10). Fewer is better when items overlap.',
    '- Do NOT map follow-ups 1:1 to issues, and do NOT over-split. Each issue should',
    '  cover MULTIPLE related follow-ups whenever they share a theme or root cause.',
    '- Each issue title MUST follow `type(scope): what — why`',
    '  (type ∈ feat|fix|refactor|chore|docs|test|perf).',
    '- priority is a number 1..4 (1=urgent, 2=high, 3=medium, 4=low).',
    '',
    'Output ONLY a JSON object in a ```json code block, shaped exactly like this',
    '(maximum 10 issues in the array):',
    '',
    '```json',
    '{',
    '  "issues": [',
    '    {',
    '      "title": "refactor(scope): consolidate X — why",',
    '      "priority": 2,',
    '      "items": ["grouped follow-up title", "another grouped follow-up title"],',
    '      "description": "## Background\\n…\\n## Included follow-ups\\n- title (file:line)\\n…\\n## Completion criteria\\n- …"',
    '    }',
    '  ]',
    '}',
    '```',
  ].join('\n');
}

/**
 * Parse a JSON block. codex-responses sometimes emits the block as an *escaped*
 * JSON string (literal \n, \"), so a raw JSON.parse fails on the leading `\`. Try
 * raw first, then decode-once-then-parse. Returns undefined on total failure. (INT-2239)
 */
function parseJsonLoose(s: string): unknown {
  const t = s.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* maybe an escaped JSON string — fall through */
  }
  try {
    const decoded = JSON.parse(`"${t}"`);
    if (typeof decoded === 'string') return JSON.parse(decoded);
  } catch {
    /* fall through */
  }
  return undefined;
}

/**
 * Parse the PM output: extract the ```json block, validate `.issues`, normalize
 * each field with type guards, and clamp to the first 10. Returns [] (with an
 * optional warning) when nothing usable is found.
 */
export function parseSynthesisOutput(stdout: string, onLog?: (l: string) => void): SynthesizedIssue[] {
  const block = stdout.match(/```json\s*([\s\S]*?)\s*```/);
  if (!block) {
    onLog?.('[auditPM] No ```json block in synthesis output — skipping synthesis.');
    return [];
  }

  const parsed = parseJsonLoose(block[1]);
  if (parsed === undefined) {
    onLog?.('[auditPM] Failed to parse synthesis JSON (raw + escaped) — skipping synthesis.');
    return [];
  }

  const issuesRaw = (parsed as { issues?: unknown })?.issues;
  if (!Array.isArray(issuesRaw)) {
    onLog?.('[auditPM] Synthesis JSON missing an "issues" array — skipping synthesis.');
    return [];
  }

  const normalized: SynthesizedIssue[] = [];
  for (const raw of issuesRaw) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;

    const title = typeof r.title === 'string' ? r.title.trim() : '';
    if (!title) continue; // a titleless issue is unfileable

    const priorityNum = typeof r.priority === 'number' ? Math.trunc(r.priority) : 3;
    const priority = priorityNum >= 1 && priorityNum <= 4 ? priorityNum : 3;

    const items = Array.isArray(r.items) ? r.items.filter((i): i is string => typeof i === 'string') : [];
    const description = typeof r.description === 'string' ? r.description : '';

    normalized.push({ title, priority, items, description });
  }

  return normalized.slice(0, MAX_ISSUES);
}

export interface SynthesizeOptions {
  /** Adapter override (default: configured default). */
  adapter?: string;
  /** Repo path the synthesis runs in (read-only). */
  cwd: string;
  /** Repo name, shown in the prompt. */
  repoName: string;
  /** Optional log sink for progress/warnings. */
  onLog?: (l: string) => void;
}

/**
 * Run the PM synthesis pass over deduped audit follow-ups. Returns AT MOST 10
 * cohesive issues, or [] when there's too little to synthesize / the LLM output
 * can't be parsed (the caller then falls back gracefully).
 */
export async function synthesizeAuditIssues(
  actions: RecommendedAction[],
  opts: SynthesizeOptions,
): Promise<SynthesizedIssue[]> {
  // Too few follow-ups → synthesis adds no value; let the caller file directly.
  if (actions.length <= MIN_ACTIONS_TO_SYNTHESIZE) return [];

  const prompt = buildSynthesisPrompt(actions, opts.repoName);

  try {
    const adapter = getAdapter(opts.adapter);
    const raw = await spawnCli(adapter, {
      prompt,
      cwd: opts.cwd,
      timeoutMs: 600_000,
      maxTurns: 10,
      systemPrompt: getPrompts().systemPrompt,
      onLog: opts.onLog,
    });

    if (raw.exitCode !== 0 && !raw.stdout.trim()) {
      opts.onLog?.(
        `[auditPM] Synthesis adapter exited ${raw.exitCode}: ${raw.stderr.slice(0, 200) || 'no output'}`,
      );
      return [];
    }

    return parseSynthesisOutput(raw.stdout, opts.onLog);
  } catch (e) {
    opts.onLog?.(`[auditPM] Synthesis failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
