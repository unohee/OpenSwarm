// ============================================
// OpenSwarm — Linear output formatter
// ============================================
//
// Implements the scannable-update convention used across the workspace
// (conclusion-first, structured bullets, code references, absolute dates,
// and NO decorative emoji in issue/comment bodies). Structure — not emoji —
// carries the scannability.
//
// Pure string builders: no I/O, no side effects. This keeps the rules in one
// place and makes the formatting unit-testable.

/** Absolute date `YYYY-MM-DD` — bodies never use relative or full-ISO dates. */
export function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** A `file:line` code reference (or just the path when no line is given). */
export function codeRef(file: string, line?: number): string {
  return line != null ? `${file}:${line}` : file;
}

const BULLET = '- ';

/** Render a section body: a string becomes a paragraph, an array becomes a bullet list. */
function renderBody(body: string | string[]): string {
  if (Array.isArray(body)) {
    return body
      .filter((line) => line && line.trim())
      .map((line) => `${BULLET}${line}`)
      .join('\n');
  }
  return body.trim();
}

export interface CommentSection {
  /** Bold sub-label, e.g. "Worker". Rendered as `**label**`. */
  label: string;
  /** Body under the label — string → paragraph, array → bullet list. */
  body: string | string[];
}

export interface AutomationCommentInput {
  /** Conclusion-first heading, e.g. "Task complete". Rendered bold. */
  heading: string;
  /** Optional one-line TL;DR directly under the heading. */
  summary?: string;
  /** Structured sections — empty ones are dropped. */
  sections?: CommentSection[];
  /** Footer key→value facts (session, attempts, …), joined on one muted line. */
  meta?: Record<string, string | number | undefined>;
  /** Footer attribution. Default: "Automated by OpenSwarm". */
  attribution?: string;
  /** Footer date (absolute). Defaults to today. */
  date?: Date;
}

/**
 * Build a scannable automation comment: bold conclusion-first heading, optional
 * TL;DR, structured sections, and a single muted footer line (facts + attribution
 * + absolute date). No decorative emoji in the body.
 */
export function formatAutomationComment(input: AutomationCommentInput): string {
  const parts: string[] = [`**${input.heading}**`];

  if (input.summary?.trim()) parts.push(input.summary.trim());

  for (const section of input.sections ?? []) {
    const rendered = renderBody(section.body);
    if (rendered) parts.push(`**${section.label}**\n${rendered}`);
  }

  const facts = input.meta
    ? Object.entries(input.meta)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${k}: ${v}`)
    : [];
  facts.push(`${input.attribution ?? 'Automated by OpenSwarm'} · ${isoDate(input.date)}`);

  return `${parts.join('\n\n')}\n\n---\n${facts.join(' · ')}`;
}

export interface IssueDescriptionInput {
  problem?: string;
  cause?: string;
  solution?: string;
  verification?: string;
}

/**
 * Build a bug/work issue description in the Problem / Cause / Solution /
 * Verification layout. Empty sections are omitted.
 */
export function formatIssueDescription(input: IssueDescriptionInput): string {
  const order: [keyof IssueDescriptionInput, string][] = [
    ['problem', 'Problem'],
    ['cause', 'Cause'],
    ['solution', 'Solution'],
    ['verification', 'Verification'],
  ];
  return order
    .filter(([key]) => input[key]?.trim())
    .map(([key, label]) => `**${label}** — ${input[key]!.trim()}`)
    .join('\n\n');
}

export interface TaskDescriptionInput {
  /** One-line (or short) summary of the sub-task. */
  summary: string;
  scope?: string[];
  verify?: string[];
  dependsOn?: string[];
  fileScope?: string[];
  estimateMinutes?: number;
  /** Parent title for the auto-decomposition attribution footer. */
  parentTitle?: string;
}

/**
 * Build a decomposition sub-issue description: a summary, then scannable
 * Scope / Verify sections and a facts list (depends-on, file scope, estimate),
 * with an attribution footer.
 */
export function formatTaskDescription(input: TaskDescriptionInput): string {
  const parts: string[] = [input.summary.trim()];

  if (input.scope?.length) {
    parts.push(`**Scope**\n${input.scope.map((s) => `${BULLET}${s}`).join('\n')}`);
  }
  if (input.verify?.length) {
    parts.push(`**Verify**\n${input.verify.map((s) => `${BULLET}${s}`).join('\n')}`);
  }

  const facts: string[] = [];
  if (input.dependsOn?.length) facts.push(`Depends on: ${input.dependsOn.join(', ')}`);
  if (input.fileScope?.length) facts.push(`File scope: ${input.fileScope.join(', ')}`);
  if (input.estimateMinutes != null) facts.push(`Estimate: ${input.estimateMinutes} min`);
  if (facts.length) parts.push(facts.map((f) => `${BULLET}${f}`).join('\n'));

  let body = parts.join('\n\n');
  if (input.parentTitle) {
    body += `\n\n---\n_Auto-decomposed from "${input.parentTitle}" by Planner_`;
  }
  return body;
}
