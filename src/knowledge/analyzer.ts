// ============================================
// OpenSwarm - Knowledge Graph Analyzer
// Issue impact analysis, module health, review focus
// ============================================

import type { KnowledgeGraph } from './graph.js';
import type { ImpactAnalysis, ProjectSummary } from './types.js';

// Issue Impact Analysis

/**
 * Analyze issue text to identify affected modules
 */
export function analyzeIssueImpact(
  graph: KnowledgeGraph,
  issueTitle: string,
  issueDescription?: string,
): ImpactAnalysis {
  const text = `${issueTitle} ${issueDescription ?? ''}`.toLowerCase();

  // Step 1: Find modules directly referenced in issue text
  const directModules: string[] = [];
  const allModules = graph.getNodesByType('module');

  for (const mod of allModules) {
    // Match by filename, path segment, or module name
    const name = mod.name.replace(/\.[^.]+$/, ''); // Remove extension
    const pathParts = mod.path.split('/');

    // Filename matching (e.g., "decisionEngine" → decisionEngine.ts)
    if (text.includes(name.toLowerCase())) {
      directModules.push(mod.id);
      continue;
    }

    // camelCase → word-split matching (e.g., "decision engine" → decisionEngine.ts)
    const words = name.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
    if (words.includes(' ') && text.includes(words)) {
      directModules.push(mod.id);
      continue;
    }

    // Directory/file path matching (e.g., "orchestration/taskParser")
    if (pathParts.length >= 2) {
      const pathRef = pathParts.slice(-2).join('/').toLowerCase().replace(/\.[^.]+$/, '');
      if (text.includes(pathRef)) {
        directModules.push(mod.id);
      }
    }
  }

  // Step 2: Find modules that import the direct modules
  const dependentModules = new Set<string>();
  for (const modId of directModules) {
    const deps = graph.getDependents(modId);
    for (const dep of deps) {
      if (!directModules.includes(dep.id)) {
        dependentModules.add(dep.id);
      }
    }
  }

  // Step 3: Find related test files
  const testFiles = new Set<string>();
  const allAffected = [...directModules, ...dependentModules];
  for (const modId of allAffected) {
    const tests = graph.getTests(modId);
    for (const test of tests) {
      testFiles.add(test.id);
    }
  }

  // Step 4: Estimate impact scope
  const totalAffected = directModules.length + dependentModules.size;
  let estimatedScope: 'small' | 'medium' | 'large';
  if (totalAffected <= 2) estimatedScope = 'small';
  else if (totalAffected <= 8) estimatedScope = 'medium';
  else estimatedScope = 'large';

  return {
    directModules,
    dependentModules: Array.from(dependentModules),
    testFiles: Array.from(testFiles),
    estimatedScope,
  };
}

// Module Health

export interface ModuleHealth {
  moduleId: string;
  hasTests: boolean;
  dependentCount: number;     // Number of modules that depend on this module
  importCount: number;        // Number of imports this module makes
  churnScore: number;         // Recent change frequency
  loc: number;
  risk: 'low' | 'medium' | 'high';
}

/**
 * Health check for an individual module
 */
export function getModuleHealth(graph: KnowledgeGraph, moduleId: string): ModuleHealth | null {
  const mod = graph.getNode(moduleId);
  if (!mod || (mod.type !== 'module' && mod.type !== 'test_file')) return null;

  const tests = graph.getTests(moduleId);
  const dependents = graph.getDependents(moduleId);
  const imports = graph.getImports(moduleId);

  const hasTests = tests.length > 0;
  const dependentCount = dependents.length;
  const importCount = imports.length;
  const churnScore = mod.gitInfo?.churnScore ?? 0;
  const loc = mod.metrics?.loc ?? 0;

  // Risk assessment
  let risk: 'low' | 'medium' | 'high' = 'low';

  // High churn + no tests → high
  if (churnScore > 0.5 && !hasTests) risk = 'high';
  // Many dependents + no tests → high
  else if (dependentCount >= 5 && !hasTests) risk = 'high';
  // High churn or many dependents → medium
  else if (churnScore > 0.3 || dependentCount >= 3) risk = 'medium';
  // Large file without tests → medium
  else if (!hasTests && loc > 200) risk = 'medium';

  return {
    moduleId,
    hasTests,
    dependentCount,
    importCount,
    churnScore,
    loc,
    risk,
  };
}

// Review Focus

export interface ReviewFocus {
  criticalModules: string[];   // Modules requiring focused review
  suggestedTests: string[];    // Tests that must be run
  reasons: string[];           // Review points
}

/**
 * Suggest review focus based on changed files
 */
export function suggestReviewFocus(
  graph: KnowledgeGraph,
  changedFiles: string[],
): ReviewFocus {
  const criticalModules: string[] = [];
  const suggestedTests = new Set<string>();
  const reasons: string[] = [];

  for (const file of changedFiles) {
    const mod = graph.getNode(file);
    if (!mod) continue;

    // Files with many dependents → focus review
    const dependents = graph.getDependents(file);
    if (dependents.length >= 3) {
      criticalModules.push(file);
      reasons.push(`${mod.name}: ${dependents.length} modules depend on this — wide impact`);
    }

    // Frequently changed files → attention needed
    if (mod.gitInfo && mod.gitInfo.churnScore > 0.5) {
      if (!criticalModules.includes(file)) criticalModules.push(file);
      reasons.push(`${mod.name}: frequent recent changes (churn=${mod.gitInfo.churnScore})`);
    }

    // Collect related tests
    const tests = graph.getTests(file);
    for (const t of tests) {
      suggestedTests.add(t.id);
    }

    // Warning for changed files without tests
    if (tests.length === 0 && mod.type === 'module') {
      reasons.push(`${mod.name}: no tests — manual verification required`);
    }
  }

  return {
    criticalModules,
    suggestedTests: Array.from(suggestedTests),
    reasons,
  };
}

/**
 * Overall project health summary
 */
export function getProjectHealth(graph: KnowledgeGraph): {
  summary: ProjectSummary;
  riskModules: ModuleHealth[];
} {
  const summary = graph.buildSummary();
  const modules = graph.getNodesByType('module');

  const riskModules: ModuleHealth[] = [];
  for (const mod of modules) {
    const health = getModuleHealth(graph, mod.id);
    if (health && health.risk !== 'low') {
      riskModules.push(health);
    }
  }

  // Sort by risk level (high → medium)
  riskModules.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.risk] - order[b.risk];
  });

  return { summary, riskModules };
}
