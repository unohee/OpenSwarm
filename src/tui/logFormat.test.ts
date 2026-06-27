import { describe, it, expect } from 'vitest';
import { parseLogLine, type LogSegment } from './logFormat.js';

const find = (segs: LogSegment[], text: string) => segs.find((s) => s.text === text);
const joined = (segs: LogSegment[]) => segs.map((s) => s.text).join('');

describe('parseLogLine (INT-1974)', () => {
  it('colors the stage tag by stage and preserves the full text', () => {
    const line = '[worker] [de-artifact | INT-1918 | worktree/0cc4e232] Codex turn completed';
    const segs = parseLogLine(line);
    expect(joined(segs)).toBe(line); // lossless
    expect(find(segs, '[worker]')).toMatchObject({ color: 'cyan', bold: true });
    expect(find(segs, '[reviewer]')).toBeUndefined();
  });

  it('highlights issue id (yellow bold), worktree (dim), project (green)', () => {
    const segs = parseLogLine('[worker] [de-artifact | INT-1918 | worktree/0cc4e232] body');
    expect(find(segs, 'INT-1918')).toMatchObject({ color: 'yellow', bold: true });
    expect(find(segs, 'worktree/0cc4e232')).toMatchObject({ dim: true });
    expect(find(segs, 'de-artifact')).toMatchObject({ color: 'green' });
  });

  it('handles AUD-style ids and project names with spaces', () => {
    const segs = parseLogLine('[worker] [WAVE - Rust synth | AUD-160 | worktree/8fZ2ea25] x');
    expect(find(segs, 'AUD-160')).toMatchObject({ color: 'yellow' });
    expect(find(segs, 'WAVE - Rust synth')).toMatchObject({ color: 'green' });
  });

  it('colors error/halt bodies red and success bodies green', () => {
    const err = parseLogLine('[worker] [p | INT-1 | worktree/a] {"success": false, "haltReason": "x"}');
    expect(err.some((s) => s.color === 'red')).toBe(true);
    const ok = parseLogLine('[reviewer] [p | INT-1 | worktree/a] review approved');
    expect(ok.some((s) => s.color === 'green')).toBe(true);
  });

  it('highlights inline `code` spans in cyan within the body', () => {
    const segs = parseLogLine('[worker] [p | INT-1 | worktree/a] edit `ab-player.js` now');
    expect(find(segs, '`ab-player.js`')).toMatchObject({ color: 'cyan' });
  });

  it('falls back gracefully for a plain line', () => {
    const segs = parseLogLine('just a plain message');
    expect(joined(segs)).toBe('just a plain message');
  });
});
