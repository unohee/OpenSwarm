import { describe, it, expect, vi } from 'vitest';
import {
  judgeGoalComplexity,
  buildGoalPursuitPrompt,
  runGoalCommand,
  type GoalCommandDeps,
} from './goalCommand.js';
import type { PlanIO } from './planCommand.js';

const io = (lines: string[] = []): PlanIO => ({
  print: (l) => lines.push(l),
  confirm: async () => 'yes',
  promptText: async () => '',
});

describe('judgeGoalComplexity (INT-1821)', () => {
  it('classifies a single focused change as simple', () => {
    expect(judgeGoalComplexity('fix the typo in README')).toBe('simple');
    expect(judgeGoalComplexity('add a debug log to worker.ts')).toBe('simple');
    expect(judgeGoalComplexity('')).toBe('simple');
  });

  it('classifies heavyweight keywords as complex', () => {
    expect(judgeGoalComplexity('refactor the entire auth module')).toBe('complex');
    expect(judgeGoalComplexity('migrate the build to ESM')).toBe('complex');
  });

  it('classifies enumerated / multi-deliverable goals as complex', () => {
    expect(judgeGoalComplexity('1. add login\n2. add logout\n3. add session')).toBe('complex');
    expect(
      judgeGoalComplexity('Add a cache layer and wire it into the API and update the docs and tests'),
    ).toBe('complex');
  });

  it('handles Korean complexity signals', () => {
    expect(judgeGoalComplexity('전체 아키텍처를 재설계하고 여러 모듈을 통합')).toBe('complex');
    expect(judgeGoalComplexity('오타 하나 고쳐줘')).toBe('simple');
  });
});

describe('buildGoalPursuitPrompt', () => {
  it('frames the goal as an autonomous task and embeds it verbatim', () => {
    const p = buildGoalPursuitPrompt('  add a retry  ');
    expect(p).toContain('autonomously');
    expect(p).toContain('add a retry');
  });
});

describe('runGoalCommand routing (INT-1821)', () => {
  const mkDeps = (over: Partial<GoalCommandDeps> = {}): Required<Pick<GoalCommandDeps, 'pursue' | 'plan'>> & GoalCommandDeps => ({
    pursue: vi.fn(async () => {}),
    plan: vi.fn(async () => {}),
    ...over,
  });

  it('routes a simple goal to pursue (not plan)', async () => {
    const deps = mkDeps({ judge: () => 'simple' });
    const lines: string[] = [];
    const c = await runGoalCommand('do a small thing', io(lines), {}, deps);
    expect(c).toBe('simple');
    expect(deps.pursue).toHaveBeenCalledOnce();
    expect(deps.plan).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/Simple goal/);
  });

  it('routes a complex goal to plan (not pursue)', async () => {
    const deps = mkDeps({ judge: () => 'complex' });
    const lines: string[] = [];
    const c = await runGoalCommand('refactor everything', io(lines), {}, deps);
    expect(c).toBe('complex');
    expect(deps.plan).toHaveBeenCalledOnce();
    expect(deps.pursue).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/Complex goal/);
  });

  it('uses the real heuristic when no judge is injected', async () => {
    const deps = mkDeps();
    expect(await runGoalCommand('migrate the entire build to ESM and update docs', io(), {}, deps)).toBe('complex');
    expect(deps.plan).toHaveBeenCalledOnce();
  });

  it('prints usage and routes nowhere for an empty goal', async () => {
    const deps = mkDeps();
    const lines: string[] = [];
    const c = await runGoalCommand('   ', io(lines), {}, deps);
    expect(c).toBe('simple');
    expect(deps.pursue).not.toHaveBeenCalled();
    expect(deps.plan).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/Usage: \/goal/);
  });

  it('passes options through to the plan handler', async () => {
    const plan = vi.fn(async () => {});
    await runGoalCommand('refactor all the things', io(), { projectPath: '/x', model: 'm' }, { judge: () => 'complex', plan });
    expect(plan).toHaveBeenCalledWith('refactor all the things', expect.anything(), expect.objectContaining({ projectPath: '/x', model: 'm' }));
  });
});
