import { describe, it, expect } from 'vitest';
import {
  buildSynthesisPrompt,
  parseSynthesisOutput,
  synthesizeAuditIssues,
} from './auditPM.js';
import type { RecommendedAction } from '../agents/agentPair.js';

const actions: RecommendedAction[] = [
  { type: 'refactor', title: 'extract shared parser', location: 'src/a.ts:10' },
  { type: 'test', title: 'cover error path', location: 'src/b.ts:42' },
  { type: 'fix', title: 'handle null input' }, // no location
];

describe('buildSynthesisPrompt (INT-2225)', () => {
  it('lists each follow-up as "- [type] title (location)"', () => {
    const prompt = buildSynthesisPrompt(actions, 'OpenSwarm');
    expect(prompt).toContain('- [refactor] extract shared parser (src/a.ts:10)');
    expect(prompt).toContain('- [test] cover error path (src/b.ts:42)');
    // No location → no parenthetical.
    expect(prompt).toContain('- [fix] handle null input');
    expect(prompt).not.toContain('handle null input (');
  });

  it('includes the repo name and the AT MOST 10 / maximum 10 guidance', () => {
    const prompt = buildSynthesisPrompt(actions, 'MyRepo');
    expect(prompt).toContain('MyRepo');
    expect(prompt).toContain('PM triaging a codebase audit');
    expect(prompt).toContain('AT MOST 10');
    expect(prompt).toContain('maximum 10');
    expect(prompt).toContain('type(scope): what — why');
  });
});

describe('parseSynthesisOutput (INT-2225)', () => {
  it('parses a well-formed ```json block', () => {
    const stdout = [
      'Here is the plan:',
      '```json',
      JSON.stringify({
        issues: [
          {
            title: 'refactor(parser): consolidate parsing — reduce dup',
            priority: 2,
            items: ['extract shared parser', 'cover error path'],
            description: '## Background\nstuff',
          },
        ],
      }),
      '```',
    ].join('\n');
    const out = parseSynthesisOutput(stdout);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      title: 'refactor(parser): consolidate parsing — reduce dup',
      priority: 2,
      items: ['extract shared parser', 'cover error path'],
      description: '## Background\nstuff',
    });
  });

  it('clamps 11 issues down to 10', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      title: `fix(x): issue ${i}`,
      priority: 3,
      items: [`item ${i}`],
      description: `body ${i}`,
    }));
    const stdout = '```json\n' + JSON.stringify({ issues: many }) + '\n```';
    const out = parseSynthesisOutput(stdout);
    expect(out).toHaveLength(10);
    expect(out[9].title).toBe('fix(x): issue 9');
  });

  it('returns [] for invalid JSON', () => {
    const stdout = '```json\n{ not valid json,, }\n```';
    expect(parseSynthesisOutput(stdout)).toEqual([]);
  });

  it('returns [] when there is no json block', () => {
    expect(parseSynthesisOutput('just some prose, no block')).toEqual([]);
  });

  it('returns [] when the issues array is missing', () => {
    expect(parseSynthesisOutput('```json\n{"foo":1}\n```')).toEqual([]);
  });

  it('parses an ESCAPED JSON block (codex-responses emits literal \\n / \\") (INT-2239)', () => {
    // The block content is an escaped JSON string, not raw JSON — raw JSON.parse
    // fails on the leading backslash; parseJsonLoose decodes once then parses.
    const inner = '\\n{\\n  \\"issues\\": [{ \\"title\\": \\"fix(x): y\\", \\"priority\\": 2, \\"items\\": [], \\"description\\": \\"d\\" }]\\n}';
    const out = parseSynthesisOutput('```json\n' + inner + '\n```');
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('fix(x): y');
    expect(out[0].priority).toBe(2);
  });

  it('applies defaults for missing/out-of-range fields and drops titleless issues', () => {
    const stdout =
      '```json\n' +
      JSON.stringify({
        issues: [
          { title: 'fix(a): real one' }, // missing priority/items/description
          { title: 'fix(b): bad priority', priority: 99, items: 'nope', description: 5 },
          { priority: 2, items: ['x'] }, // no title → dropped
        ],
      }) +
      '\n```';
    const out = parseSynthesisOutput(stdout);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: 'fix(a): real one', priority: 3, items: [], description: '' });
    // Out-of-range priority → default 3; non-array items → []; non-string description → ''.
    expect(out[1]).toEqual({ title: 'fix(b): bad priority', priority: 3, items: [], description: '' });
  });

  it('logs a warning via onLog when parsing fails', () => {
    const logs: string[] = [];
    parseSynthesisOutput('no block here', (l) => logs.push(l));
    expect(logs.some((l) => l.includes('No ```json block'))).toBe(true);
  });
});

describe('synthesizeAuditIssues guard (INT-2225)', () => {
  it('returns [] without invoking the LLM when there are too few follow-ups', async () => {
    // 3 actions ≤ MIN_ACTIONS_TO_SYNTHESIZE (3) → short-circuit, no adapter call.
    const out = await synthesizeAuditIssues(actions, { cwd: '/tmp', repoName: 'X' });
    expect(out).toEqual([]);
  });

  it('returns [] for an empty action list', async () => {
    const out = await synthesizeAuditIssues([], { cwd: '/tmp', repoName: 'X' });
    expect(out).toEqual([]);
  });
});
