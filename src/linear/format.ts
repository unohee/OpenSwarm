// ============================================
// OpenSwarm — Linear output formatter
// ============================================
//
// Writes Linear comments/issues the way an engineer would: a plain-language lead,
// short facts kept inline, lists only where they help, and a quiet sign-off — not
// a telemetry dump. Still scannable (conclusion first, code refs, absolute dates),
// just without the robotic feel.
//
// Pure string builders: no I/O, no side effects, so the style lives in one place
// and stays unit-testable.

/** Absolute date `YYYY-MM-DD` — bodies never use relative or full-ISO dates. */
export function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** A `file:line` code reference (or just the path when no line is given). */
export function codeRef(file: string, line?: number): string {
  return line != null ? `${file}:${line}` : file;
}

const BULLET = '- ';

export interface CommentSection {
  /** Short label, e.g. "Reviewer". */
  label: string;
  /** A one-liner (kept inline), a multi-line note, or a list (rendered as bullets). */
  body: string | string[];
}

/**
 * Render a section the way someone would jot it down: a short single-line fact
 * goes inline (`**Label:** value`); a list or a multi-line note gets its own block.
 */
function renderSection(section: CommentSection): string {
  if (Array.isArray(section.body)) {
    const items = section.body.filter((line) => line && line.trim());
    return items.length ? `**${section.label}:**\n${items.map((l) => `${BULLET}${l}`).join('\n')}` : '';
  }
  const text = section.body.trim();
  if (!text) return '';
  return text.includes('\n')
    ? `**${section.label}:**\n${text}`
    : `**${section.label}:** ${text}`;
}

export interface AutomationCommentInput {
  /** Short bold lead, e.g. "Task complete". */
  heading: string;
  /** A natural one- or two-line summary in plain language — the voice of the comment. */
  summary?: string;
  /** Supporting details — empty ones are dropped. */
  sections?: CommentSection[];
  /** Trace facts for the quiet sign-off (session, attempts, …). */
  meta?: Record<string, string | number | undefined>;
  /** Sign-off attribution. Default: "via OpenSwarm". */
  attribution?: string;
  /** Sign-off date (absolute). Defaults to today. */
  date?: Date;
}

/**
 * Build a comment that reads like a person wrote it: bold lead, a plain-language
 * summary, a few supporting details, and a single muted (italic) sign-off line
 * carrying just enough trace to find the run later.
 */
export function formatAutomationComment(input: AutomationCommentInput): string {
  const parts: string[] = [`**${input.heading}**`];

  if (input.summary?.trim()) parts.push(input.summary.trim());

  for (const section of input.sections ?? []) {
    const rendered = renderSection(section);
    if (rendered) parts.push(rendered);
  }

  const trace: string[] = [];
  const attribution = input.attribution ?? 'via OpenSwarm';
  if (attribution) trace.push(attribution);
  if (input.meta) {
    for (const [key, value] of Object.entries(input.meta)) {
      if (value !== undefined && value !== '') trace.push(`${key} ${value}`);
    }
  }
  trace.push(isoDate(input.date));

  return `${parts.join('\n\n')}\n\n_${trace.join(' · ')}_`;
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
  /** Parent title for the auto-decomposition sign-off. */
  parentTitle?: string;
}

/**
 * Build a decomposition sub-issue description: a summary, then scannable
 * Scope / Verify sections and a short facts list (depends-on, file scope,
 * estimate), with a quiet sign-off.
 */
export function formatTaskDescription(input: TaskDescriptionInput): string {
  const parts: string[] = [input.summary.trim()];

  if (input.scope?.length) {
    parts.push(`**Scope:**\n${input.scope.map((s) => `${BULLET}${s}`).join('\n')}`);
  }
  if (input.verify?.length) {
    parts.push(`**Verify:**\n${input.verify.map((s) => `${BULLET}${s}`).join('\n')}`);
  }

  const facts: string[] = [];
  if (input.dependsOn?.length) facts.push(`Depends on: ${input.dependsOn.join(', ')}`);
  if (input.fileScope?.length) facts.push(`File scope: ${input.fileScope.join(', ')}`);
  if (input.estimateMinutes != null) facts.push(`Estimate: ${input.estimateMinutes} min`);
  if (facts.length) parts.push(facts.map((f) => `${BULLET}${f}`).join('\n'));

  let body = parts.join('\n\n');
  if (input.parentTitle) {
    body += `\n\n_Split out from "${input.parentTitle}" during planning._`;
  }
  return body;
}
