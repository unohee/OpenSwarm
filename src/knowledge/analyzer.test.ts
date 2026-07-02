import { describe, it, expect, beforeEach } from 'vitest';
import { KnowledgeGraph } from './graph.js';
import {
  analyzeIssueImpact,
  getProjectHealth,
  suggestReviewFocus,
  getModuleHealth,
} from './analyzer.js';
import type { GraphNode, GraphEdge } from './types.js';

// Helper to create a module node
function mod(id: string, overrides?: Partial<GraphNode>): GraphNode {
  const name = id.split('/').pop()!;
  return {
    id,
    type: 'module',
    name,
    path: id,
    metrics: { loc: 100, exportCount: 3, importCount: 2, language: 'typescript' },
    ...overrides,
  };
}

// Helper to create a test file node
function testFile(id: string): GraphNode {
  const name = id.split('/').pop()!;
  return { id, type: 'test_file', name, path: id };
}

// Helper to create an edge
function edge(source: string, target: string, type: GraphEdge['type']): GraphEdge {
  return { source, target, type };
}

describe('Knowledge Graph Analyzer', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = new KnowledgeGraph('test-project', '/tmp/test-project');

    // 5 module nodes
    graph.addNode(mod('src/auth/login.ts', {
      gitInfo: { lastCommitDate: Date.now(), commitCount30d: 12, churnScore: 0.6 },
      metrics: { loc: 150, exportCount: 4, importCount: 2, language: 'typescript' },
    }));
    graph.addNode(mod('src/auth/token.ts', {
      gitInfo: { lastCommitDate: Date.now(), commitCount30d: 3, churnScore: 0.2 },
    }));
    graph.addNode(mod('src/api/routes.ts', {
      gitInfo: { lastCommitDate: Date.now(), commitCount30d: 8, churnScore: 0.4 },
      metrics: { loc: 250, exportCount: 6, importCount: 4, language: 'typescript' },
    }));
    graph.addNode(mod('src/api/middleware.ts', {
      gitInfo: { lastCommitDate: Date.now(), commitCount30d: 2, churnScore: 0.1 },
    }));
    graph.addNode(mod('src/utils/helpers.ts', {
      gitInfo: { lastCommitDate: Date.now(), commitCount30d: 1, churnScore: 0.05 },
    }));

    // 2 test file nodes
    graph.addNode(testFile('src/auth/login.test.ts'));
    graph.addNode(testFile('src/api/routes.test.ts'));

    // Import edges: routes→login, routes→middleware, middleware→token, login→helpers
    graph.addEdge(edge('src/api/routes.ts', 'src/auth/login.ts', 'imports'));
    graph.addEdge(edge('src/api/routes.ts', 'src/api/middleware.ts', 'imports'));
    graph.addEdge(edge('src/api/middleware.ts', 'src/auth/token.ts', 'imports'));
    graph.addEdge(edge('src/auth/login.ts', 'src/utils/helpers.ts', 'imports'));

    // Test edges: login.test→login, routes.test→routes
    graph.addEdge(edge('src/auth/login.test.ts', 'src/auth/login.ts', 'tests'));
    graph.addEdge(edge('src/api/routes.test.ts', 'src/api/routes.ts', 'tests'));
  });

  // ============================================
  // analyzeIssueImpact
  // ============================================

  describe('analyzeIssueImpact', () => {
    it('finds login.ts as direct match and routes.ts as dependent', () => {
      const result = analyzeIssueImpact(graph, 'Login page broken', 'Users cannot login');

      expect(result.directModules).toContain('src/auth/login.ts');
      // routes.ts imports login.ts, so it should appear as dependent
      expect(result.dependentModules).toContain('src/api/routes.ts');
    });

    it('finds token.ts when issue mentions "token"', () => {
      const result = analyzeIssueImpact(graph, 'Token refresh failing', 'JWT token refresh endpoint returns 401');

      expect(result.directModules).toContain('src/auth/token.ts');
    });

    it('includes middleware.ts as dependent of token.ts', () => {
      const result = analyzeIssueImpact(graph, 'Token expired bug');

      expect(result.directModules).toContain('src/auth/token.ts');
      // middleware imports token, so it is a dependent
      expect(result.dependentModules).toContain('src/api/middleware.ts');
    });

    it('returns empty arrays when no modules match', () => {
      const result = analyzeIssueImpact(graph, 'UI color scheme', 'Change button colors');

      expect(result.directModules).toEqual([]);
      expect(result.dependentModules).toEqual([]);
      expect(result.testFiles).toEqual([]);
    });

    it('does not match short generic vendored filenames as substrings (INT-2320)', () => {
      // a.py / run.py used to substring-match virtually every issue text,
      // making the conflict detector see all task pairs as overlapping.
      graph.addNode(mod('vendor/dns/a.py'));
      graph.addNode(mod('vendor/tasks/run.py'));
      graph.addNode(mod('vendor/requests/api.py'));

      const result = analyzeIssueImpact(
        graph,
        'Harden the running audit pipeline',
        'API change compatibility risk around a rapid rollout',
      );

      expect(result.directModules).not.toContain('vendor/dns/a.py'); // < 3 chars: never
      expect(result.directModules).not.toContain('vendor/tasks/run.py'); // "running" is not "run"
      // "API" appears as a standalone word → a legitimate boundary match
      expect(result.directModules).toContain('vendor/requests/api.py');
    });

    it('still matches whole-word filenames at word boundaries (INT-2320)', () => {
      const result = analyzeIssueImpact(graph, 'login: broken redirect', 'the login/ page 500s');
      expect(result.directModules).toContain('src/auth/login.ts');
    });

    it('estimates scope as "small" for <= 2 affected modules', () => {
      // token.ts + middleware.ts = 2 affected
      const result = analyzeIssueImpact(graph, 'Token issue');
      expect(result.estimatedScope).toBe('small');
    });

    it('estimates scope as "medium" for 3-8 affected modules', () => {
      // login.ts (direct) + routes.ts (dependent via import) + helpers is imported by login = 2 direct + dependent
      // Actually: "login helpers" → login.ts + helpers.ts direct, routes.ts dependent = 3
      const result = analyzeIssueImpact(graph, 'Login and helpers broken');
      const total = result.directModules.length + result.dependentModules.length;
      expect(total).toBeGreaterThanOrEqual(3);
      expect(result.estimatedScope).toBe('medium');
    });

    it('collects related test files for affected modules', () => {
      const result = analyzeIssueImpact(graph, 'Login broken');

      // login.ts has login.test.ts, routes.ts (dependent) has routes.test.ts
      expect(result.testFiles).toContain('src/auth/login.test.ts');
      expect(result.testFiles).toContain('src/api/routes.test.ts');
    });

    it('matches by path segment (auth/login)', () => {
      const result = analyzeIssueImpact(graph, 'Bug in auth/login flow');
      expect(result.directModules).toContain('src/auth/login.ts');
    });
  });

  // ============================================
  // getProjectHealth
  // ============================================

  describe('getProjectHealth', () => {
    it('returns correct total module and test file counts', () => {
      const { summary } = getProjectHealth(graph);

      expect(summary.totalModules).toBe(5);
      expect(summary.totalTestFiles).toBe(2);
    });

    it('identifies untested modules', () => {
      const { summary } = getProjectHealth(graph);

      // token.ts, middleware.ts, helpers.ts have no tests
      expect(summary.untestedModules).toContain('src/auth/token.ts');
      expect(summary.untestedModules).toContain('src/api/middleware.ts');
      expect(summary.untestedModules).toContain('src/utils/helpers.ts');
      // login.ts and routes.ts are tested
      expect(summary.untestedModules).not.toContain('src/auth/login.ts');
      expect(summary.untestedModules).not.toContain('src/api/routes.ts');
    });

    it('identifies hot modules by churn score', () => {
      const { summary } = getProjectHealth(graph);

      // login.ts has highest churn (0.6), should appear first in hotModules
      expect(summary.hotModules[0]).toBe('src/auth/login.ts');
    });

    it('identifies risk modules (non-low risk)', () => {
      const { riskModules } = getProjectHealth(graph);

      // login.ts: high churn (0.6) + has tests → medium risk
      // routes.ts: 0.4 churn > 0.3 threshold → medium risk
      const riskIds = riskModules.map(m => m.moduleId);
      expect(riskIds.length).toBeGreaterThan(0);
      expect(riskModules.every(m => m.risk !== 'low')).toBe(true);
    });

    it('sorts risk modules high before medium', () => {
      const { riskModules } = getProjectHealth(graph);

      if (riskModules.length >= 2) {
        const highIdx = riskModules.findIndex(m => m.risk === 'high');
        const medIdx = riskModules.findIndex(m => m.risk === 'medium');
        if (highIdx !== -1 && medIdx !== -1) {
          expect(highIdx).toBeLessThan(medIdx);
        }
      }
    });
  });

  // ============================================
  // getModuleHealth
  // ============================================

  describe('getModuleHealth', () => {
    it('returns null for non-existent module', () => {
      const result = getModuleHealth(graph, 'src/nonexistent.ts');
      expect(result).toBeNull();
    });

    it('reports hasTests correctly for tested module', () => {
      const result = getModuleHealth(graph, 'src/auth/login.ts');
      expect(result).not.toBeNull();
      expect(result!.hasTests).toBe(true);
    });

    it('reports hasTests correctly for untested module', () => {
      const result = getModuleHealth(graph, 'src/auth/token.ts');
      expect(result).not.toBeNull();
      expect(result!.hasTests).toBe(false);
    });

    it('counts dependents correctly', () => {
      // login.ts is imported by routes.ts → 1 dependent
      const result = getModuleHealth(graph, 'src/auth/login.ts');
      expect(result!.dependentCount).toBe(1);
    });

    it('assigns medium risk for high churn module with tests', () => {
      // login.ts: churnScore=0.6 > 0.3, has tests → medium
      const result = getModuleHealth(graph, 'src/auth/login.ts');
      expect(result!.risk).toBe('medium');
    });

    it('assigns low risk for low-churn low-dependent module', () => {
      // helpers.ts: churnScore=0.05, 0 dependents (login imports it but getDependents returns importers)
      // Actually helpers is imported by login, so dependentCount=1, churn=0.05
      // 1 dependent < 3 and churn 0.05 < 0.3 → low (but no tests and loc=100 < 200 → low)
      const result = getModuleHealth(graph, 'src/utils/helpers.ts');
      expect(result!.risk).toBe('low');
    });
  });

  // ============================================
  // suggestReviewFocus
  // ============================================

  describe('suggestReviewFocus', () => {
    it('marks module with many dependents as critical', () => {
      // Add extra import edges to make helpers.ts have >= 3 dependents
      graph.addEdge(edge('src/api/routes.ts', 'src/utils/helpers.ts', 'imports'));
      graph.addEdge(edge('src/api/middleware.ts', 'src/utils/helpers.ts', 'imports'));
      graph.addEdge(edge('src/auth/token.ts', 'src/utils/helpers.ts', 'imports'));

      const result = suggestReviewFocus(graph, ['src/utils/helpers.ts']);

      expect(result.criticalModules).toContain('src/utils/helpers.ts');
      expect(result.reasons.some(r => r.includes('depend on this'))).toBe(true);
    });

    it('flags high-churn changed file as critical', () => {
      // login.ts has churnScore=0.6 > 0.5
      const result = suggestReviewFocus(graph, ['src/auth/login.ts']);

      expect(result.criticalModules).toContain('src/auth/login.ts');
      expect(result.reasons.some(r => r.includes('churn'))).toBe(true);
    });

    it('collects suggested tests for changed modules', () => {
      const result = suggestReviewFocus(graph, ['src/auth/login.ts']);

      expect(result.suggestedTests).toContain('src/auth/login.test.ts');
    });

    it('warns about changed modules without tests', () => {
      const result = suggestReviewFocus(graph, ['src/auth/token.ts']);

      expect(result.reasons.some(r => r.includes('no tests'))).toBe(true);
    });

    it('handles changed test file gracefully', () => {
      const result = suggestReviewFocus(graph, ['src/auth/login.test.ts']);

      // Test file node exists, but it has type test_file so "no tests" warning
      // should NOT appear (the warning checks mod.type === 'module')
      expect(result.reasons.every(r => !r.includes('no tests'))).toBe(true);
    });

    it('skips unknown files not in graph', () => {
      const result = suggestReviewFocus(graph, ['src/unknown/file.ts']);

      expect(result.criticalModules).toEqual([]);
      expect(result.suggestedTests).toEqual([]);
      expect(result.reasons).toEqual([]);
    });
  });
});
