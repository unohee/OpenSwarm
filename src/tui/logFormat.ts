// ============================================
// OpenSwarm - log line highlighter (INT-1974)
// ============================================
//
// Daemon log lines look like:
//   [worker] [de-artifact | INT-1918 | worktree/0cc4e232] 1) `ab-player.js`: …
// Parse one into colored segments so the Logs/Pipeline tabs render structured,
// readable output instead of a monochrome wall. Pure — the Ink <Text> spans are
// produced by components/LogLine.tsx from these segments.

export interface LogSegment {
  text: string;
  /** Ink color name (cyan/green/yellow/red/magenta/blue…). Omit for default. */
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

/** Per-pipeline-stage tag color. */
const STAGE_COLORS: Record<string, string> = {
  worker: 'cyan',
  reviewer: 'magenta',
  tester: 'yellow',
  planner: 'blue',
  documenter: 'green',
  auditor: 'red',
  'skill-documenter': 'green',
};

const ISSUE_RE = /^[A-Z]{2,}-\d+$/;

/** Level color for the message body. */
function bodyColor(body: string): string | undefined {
  const l = body.toLowerCase();
  if (/(\berror\b|\bfail|✖|✗|"success":\s*false|halt)/.test(l)) return 'red';
  if (/(✓|completed|succeed|success|done|approved|passed)/.test(l)) return 'green';
  return undefined;
}

/** Split a body into default/level-colored text with `inline code` highlighted cyan. */
function formatBody(body: string): LogSegment[] {
  if (!body) return [];
  const color = bodyColor(body);
  const out: LogSegment[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m.index > last) out.push({ text: body.slice(last, m.index), color });
    out.push({ text: `\`${m[1]}\``, color: 'cyan' });
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last), color });
  return out;
}

/** Parse a daemon log line into colored segments. (INT-1974) */
export function parseLogLine(line: string): LogSegment[] {
  const segs: LogSegment[] = [];
  let rest = line;

  // 1) leading [stage]
  const stageM = rest.match(/^\[([a-z][\w-]*)\]\s*/i);
  if (stageM) {
    const stage = stageM[1].toLowerCase();
    segs.push({ text: `[${stageM[1]}]`, color: STAGE_COLORS[stage] ?? 'white', bold: true });
    segs.push({ text: ' ' });
    rest = rest.slice(stageM[0].length);
  }

  // 2) context group [project | ISSUE | worktree/hash]
  const ctxM = rest.match(/^\[([^\]]*)\]\s*/);
  if (ctxM) {
    segs.push({ text: '[', dim: true });
    const parts = ctxM[1].split('|').map((p) => p.trim());
    parts.forEach((p, i) => {
      if (i > 0) segs.push({ text: ' | ', dim: true });
      if (ISSUE_RE.test(p)) segs.push({ text: p, color: 'yellow', bold: true });
      else if (p.startsWith('worktree/')) segs.push({ text: p, dim: true });
      else segs.push({ text: p, color: 'green' });
    });
    segs.push({ text: ']', dim: true });
    segs.push({ text: ' ' });
    rest = rest.slice(ctxM[0].length);
  }

  // 3) body
  segs.push(...formatBody(rest));
  // A line that was only a (stage/context) prefix still needs at least one segment.
  return segs.length ? segs : [{ text: line }];
}
