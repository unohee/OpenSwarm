import { describe, expect, it } from 'vitest';
import { KnowledgeGraph } from './graph.js';

describe('KnowledgeGraph traversal', () => {
  it('returns a diamond dependent only once', () => {
    const graph = new KnowledgeGraph('p', '/repo');
    for (const id of ['root', 'left', 'right', 'leaf']) {
      graph.addNode({ id, name: id, path: id, type: 'module' });
    }
    graph.addEdge({ source: 'left', target: 'root', type: 'imports' });
    graph.addEdge({ source: 'right', target: 'root', type: 'imports' });
    graph.addEdge({ source: 'leaf', target: 'left', type: 'imports' });
    graph.addEdge({ source: 'leaf', target: 'right', type: 'imports' });
    expect(graph.getTransitiveDependents('root').map((node) => node.id)).toEqual(['left', 'right', 'leaf']);
  });
});
