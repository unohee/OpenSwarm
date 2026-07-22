import { describe, expect, it } from 'vitest';
import type { CognitiveMemoryRecord } from './memoryCore.js';
import { removeDuplicates } from './compaction.js';

function record(id: string, metadata: string): CognitiveMemoryRecord {
  return {
    id, type: 'constraint', content: id, vector: [1, 0], importance: 0.5,
    confidence: 1, createdAt: 1, lastUpdated: 1, lastAccessed: 1,
    derivedFrom: 'source', repo: 'repo', title: id, metadata, trust: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

describe('memory compaction deduplication', () => {
  it('compares JSON metadata structurally regardless of key order', () => {
    expect(removeDuplicates([
      record('a', '{"project":"p","nested":{"x":1,"y":2}}'),
      record('b', '{"nested":{"y":2,"x":1},"project":"p"}'),
    ])).toHaveLength(1);
  });
});
