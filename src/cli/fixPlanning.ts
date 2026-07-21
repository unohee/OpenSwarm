// ============================================
// OpenSwarm - repository-aware fix planning
// ============================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { ReviewResult } from '../agents/agentPair.js';
import type { TrustedVerifyPlan } from '../agents/deterministicTester.js';
import { getGraph, toProjectSlug } from '../knowledge/index.js';
import { recallRepoKnowledge, repoKey, type RepoMemoryBrief } from '../memory/repoKnowledge.js';
import { loadRepoMetadata } from '../support/repoMetadata.js';
import { resolveSharedPaths } from '../support/worktreeManager.js';

export interface FixDependencyMapEntry {
  imports: string[];
  dependents: string[];
  tests: string[];
}

export interface FixRepositoryContext {
  canonicalRoot: string;
  packageManager?: string;
  workspaces: string[];
  manifests: string[];
  verificationCommands: string[];
  sharedPaths: string[];
  repoMemories: RepoMemoryBrief[];
  dependencyGraphAvailable: boolean;
  dependencyMap: Record<string, FixDependencyMapEntry>;
  preflight: { ready: boolean; issues: string[] };
}

export interface FixPlanningTarget {
  area: { label: string; dir: string; files: string[] };
  review: ReviewResult;
}

export interface FixUnit {
  label: string;
  targetLabels: string[];
  targets: FixPlanningTarget[];
  primaryFiles: string[];
  dependencyFiles: string[];
  testFiles: string[];
  manifestFiles: string[];
  /** Exact files or directories the worker may change. */
  allowedPaths: string[];
}

interface PackageManifest {
  packageManager?: unknown;
  workspaces?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
}

function readPackageManifest(projectPath: string): PackageManifest | null {
  try {
    return JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8')) as PackageManifest;
  } catch {
    return null;
  }
}

function stringRecordSize(value: unknown): number {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).length
    : 0;
}

function detectPackageManager(projectPath: string, pkg: PackageManifest | null): string | undefined {
  if (typeof pkg?.packageManager === 'string' && pkg.packageManager.trim()) {
    return pkg.packageManager.split('@')[0];
  }
  if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectPath, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(projectPath, 'bun.lock')) || existsSync(join(projectPath, 'bun.lockb'))) return 'bun';
  if (existsSync(join(projectPath, 'package-lock.json')) || pkg) return 'npm';
  return undefined;
}

function readWorkspaces(pkg: PackageManifest | null): string[] {
  const value = pkg?.workspaces;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (value && typeof value === 'object' && Array.isArray((value as { packages?: unknown }).packages)) {
    return (value as { packages: unknown[] }).packages.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function toRelative(projectPath: string, path: string): string {
  const rel = relative(resolve(projectPath), resolve(path));
  return rel || '.';
}

/** Build the repository capsule once, before any fix worker can mutate trusted inputs. */
export async function buildFixRepositoryContext(
  projectPath: string,
  plan: TrustedVerifyPlan | undefined,
  taskText: string,
): Promise<FixRepositoryContext> {
  const canonicalRoot = repoKey(projectPath);
  const pkg = readPackageManifest(projectPath);
  const packageManager = detectPackageManager(projectPath, pkg);
  const workspaces = readWorkspaces(pkg);
  const manifests = new Set<string>();
  const rootManifestNames = [
    'package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lock', 'bun.lockb',
    'pyproject.toml', 'requirements.txt', 'uv.lock', 'poetry.lock',
    'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum',
  ];
  for (const name of rootManifestNames) if (existsSync(join(projectPath, name))) manifests.add(name);
  for (const directory of Object.keys(plan?.packageJsonByDirectory ?? {})) {
    manifests.add(directory ? join(directory, 'package.json') : 'package.json');
  }

  let metadata = null;
  try { metadata = await loadRepoMetadata(canonicalRoot); } catch { metadata = null; }
  const sharedPaths = resolveSharedPaths(canonicalRoot, metadata);

  const issues: string[] = [];
  const declaredNodeDependencies = stringRecordSize(pkg?.dependencies)
    + stringRecordSize(pkg?.devDependencies)
    + stringRecordSize(pkg?.optionalDependencies);
  const nodeRuntimeReady = !pkg || declaredNodeDependencies === 0 || [
    'node_modules', '.pnp.cjs', '.pnp.loader.mjs',
  ].some((name) => existsSync(join(projectPath, name)));
  if (!nodeRuntimeReady) {
    issues.push(
      `package.json declares ${declaredNodeDependencies} dependency entries, but this worktree has no node_modules or Yarn PnP runtime. ` +
      `Install with ${packageManager ?? 'the repository package manager'} in the original repository or expose it through sandbox.sharedPaths.`,
    );
  }

  const dependencyMap: Record<string, FixDependencyMapEntry> = {};
  let dependencyGraphAvailable = false;
  try {
    const graph = await getGraph(toProjectSlug(canonicalRoot));
    if (graph) {
      dependencyGraphAvailable = true;
      for (const node of graph.getAllNodes()) {
        if (node.type !== 'module' && node.type !== 'test_file') continue;
        dependencyMap[node.id] = {
          imports: graph.getImports(node.id).map((item) => item.id),
          dependents: graph.getDependents(node.id).map((item) => item.id),
          tests: graph.getTests(node.id).map((item) => item.id),
        };
      }
    }
  } catch {
    dependencyGraphAvailable = false;
  }

  const repoMemories = await recallRepoKnowledge(
    projectPath,
    'Apply repository-wide review fixes',
    taskText,
  );

  return {
    canonicalRoot,
    packageManager,
    workspaces,
    manifests: [...manifests].sort(),
    verificationCommands: (plan?.commands ?? []).map((command) =>
      `${command.cwd ? `(${command.cwd}) ` : ''}${command.run}`),
    sharedPaths: sharedPaths.map((path) => toRelative(canonicalRoot, join(canonicalRoot, path))),
    repoMemories,
    dependencyGraphAvailable,
    dependencyMap,
    preflight: { ready: issues.length === 0, issues },
  };
}

class DisjointSet {
  private readonly parent: number[];
  constructor(size: number) { this.parent = Array.from({ length: size }, (_, index) => index); }
  find(value: number): number {
    const parent = this.parent[value];
    if (parent !== value) this.parent[value] = this.find(parent);
    return this.parent[value];
  }
  union(left: number, right: number): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parent[b] = a;
  }
}

function nearestManifests(files: string[], manifests: string[]): string[] {
  const selected = new Set<string>();
  for (const file of files) {
    let best: string | undefined;
    for (const manifest of manifests) {
      const directory = dirname(manifest);
      if (directory === '.' || file === directory || file.startsWith(`${directory}/`)) {
        if (!best || directory.length > dirname(best).length) best = manifest;
      }
    }
    if (best) selected.add(best);
  }
  return [...selected];
}

/** Merge related audit areas into fix units; independent components may run in parallel. */
export function planFixUnits(targets: FixPlanningTarget[], context: FixRepositoryContext): FixUnit[] {
  if (targets.length === 0) return [];
  const sets = new DisjointSet(targets.length);
  const owner = new Map<string, number>();
  targets.forEach((target, index) => target.area.files.forEach((file) => owner.set(file, index)));

  targets.forEach((target, index) => {
    targets.forEach((other, otherIndex) => {
      if (index < otherIndex && target.area.dir === other.area.dir) sets.union(index, otherIndex);
    });
    for (const file of target.area.files) {
      const entry = context.dependencyMap[file];
      for (const related of [...(entry?.imports ?? []), ...(entry?.dependents ?? []), ...(entry?.tests ?? [])]) {
        const relatedOwner = owner.get(related);
        if (relatedOwner !== undefined) sets.union(index, relatedOwner);
      }
    }
  });

  const components = new Map<number, FixPlanningTarget[]>();
  targets.forEach((target, index) => {
    const root = sets.find(index);
    const list = components.get(root) ?? [];
    list.push(target);
    components.set(root, list);
  });

  return [...components.values()].map((members) => {
    const primary = new Set(members.flatMap((member) => member.area.files));
    const dependencies = new Set<string>();
    const tests = new Set<string>();
    for (const file of primary) {
      const entry = context.dependencyMap[file];
      for (const related of [...(entry?.imports ?? []), ...(entry?.dependents ?? [])]) {
        if (!primary.has(related)) dependencies.add(related);
      }
      for (const test of entry?.tests ?? []) if (!primary.has(test)) tests.add(test);
    }
    const manifestFiles = nearestManifests([...primary, ...dependencies], context.manifests);
    const allowed = new Set<string>([
      ...members.map((member) => member.area.dir),
      ...dependencies,
      ...[...tests].map((file) => dirname(file)),
      ...manifestFiles,
    ]);
    const labels = members.map((member) => member.area.label);
    return {
      label: labels.length === 1 ? labels[0] : `${labels[0]} +${labels.length - 1} related`,
      targetLabels: labels,
      targets: members,
      primaryFiles: [...primary].sort(),
      dependencyFiles: [...dependencies].sort(),
      testFiles: [...tests].sort(),
      manifestFiles: manifestFiles.sort(),
      allowedPaths: [...allowed].filter(Boolean).sort(),
    };
  });
}

export function workerContextForFixUnit(unit: FixUnit, context: FixRepositoryContext) {
  const affected = unit.primaryFiles.length + unit.dependencyFiles.length;
  return {
    impactAnalysis: {
      directModules: unit.primaryFiles,
      dependentModules: unit.dependencyFiles,
      testFiles: unit.testFiles,
      estimatedScope: (affected <= 2 ? 'small' : affected <= 8 ? 'medium' : 'large') as 'small' | 'medium' | 'large',
    },
    repoMemories: context.repoMemories,
    repository: {
      packageManager: context.packageManager,
      workspaces: context.workspaces,
      manifests: context.manifests,
      verificationCommands: context.verificationCommands,
      sharedPaths: context.sharedPaths,
      dependencyGraphAvailable: context.dependencyGraphAvailable,
    },
  };
}

/** Keep path checks platform-safe and reject sibling-prefix tricks. */
export function pathWithinScope(file: string, allowedPaths: string[]): boolean {
  const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
  return allowedPaths.some((allowed) => {
    const scope = allowed.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    return normalized === scope || normalized.startsWith(`${scope}/`);
  });
}
