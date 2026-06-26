import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('pairPipeline stage ordering', () => {
  it('runs tester before reviewer and only once', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/agents/pairPipeline.ts'), 'utf8');
    const testerBlocks = [...source.matchAll(/runStage\('tester'/g)].map((m) => m.index ?? -1).filter((n) => n >= 0);
    const reviewerBlocks = [...source.matchAll(/runStage\('reviewer'/g)].map((m) => m.index ?? -1).filter((n) => n >= 0);

    expect(testerBlocks.length).toBe(1);
    expect(reviewerBlocks.length).toBe(1);
    expect(testerBlocks[0]).toBeLessThan(reviewerBlocks[0]);
    expect(source).toContain("recordReflection(context.reflection, {\n            iteration: context.currentIteration,\n            source: 'test'");
    expect(source).toContain("if (this.shouldAbortSelfRepair(context, progressed, 'test')) {");
  });
});
