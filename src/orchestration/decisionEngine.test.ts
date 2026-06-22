import { describe, it, expect } from 'vitest';
import { isUmbrellaIssue, type TaskItem } from './decisionEngine.js';

// INT-1810 R2: parent/EPIC issues are umbrellas, not executable work. INT-1702 (tracking,
// decomposed into sub-issues) and KT-300 ([EPIC] …) were wrongly picked for the worker.
function task(partial: Partial<TaskItem>): TaskItem {
  return { id: 'x', source: 'linear', title: 't', priority: 3, createdAt: 0, ...partial } as TaskItem;
}

describe('isUmbrellaIssue', () => {
  it('flags an issue that is the parent of another fetched issue', () => {
    const parent = task({ id: 'p', issueId: 'p-uuid', title: 'consolidate branches' });
    const child = task({ id: 'c', issueId: 'c-uuid', parentId: 'p-uuid', title: 'sub-task' });
    const parentIds = new Set([child.parentId!]);

    expect(isUmbrellaIssue(parent, parentIds)).toBe(true);  // p is a parent
    expect(isUmbrellaIssue(child, parentIds)).toBe(false);  // c is a leaf
  });

  it('flags EPIC-tagged titles regardless of parent links', () => {
    const noParents = new Set<string>();
    expect(isUmbrellaIssue(task({ title: '[EPIC] VEGA 채팅 하네스 이식' }), noParents)).toBe(true);
    expect(isUmbrellaIssue(task({ title: 'epic: unify backend' }), noParents)).toBe(true);
    expect(isUmbrellaIssue(task({ title: '[ Epic ] spaced + cased' }), noParents)).toBe(true);
  });

  it('does not flag normal executable issues', () => {
    const parentIds = new Set(['some-parent']);
    expect(isUmbrellaIssue(task({ issueId: 'leaf', title: 'fix(adapters): codex flag' }), parentIds)).toBe(false);
    // "epic" inside a word must not false-positive
    expect(isUmbrellaIssue(task({ issueId: 'l2', title: 'add epicenter map widget' }), parentIds)).toBe(false);
  });
});
