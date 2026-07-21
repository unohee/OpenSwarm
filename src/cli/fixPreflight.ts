// ============================================
// OpenSwarm - repository runtime preflight for review fixes
// ============================================

import {
  runDeterministicTester,
  type TrustedVerifyPlan,
} from '../agents/deterministicTester.js';
import type { VerifyConfig } from '../core/types.js';

type FixRuntimeVerifier = (
  projectPath: string,
  config: VerifyConfig,
  trustedCommands: TrustedVerifyPlan['commands'],
  trustedPackageJsonByDirectory: TrustedVerifyPlan['packageJsonByDirectory'],
) => Promise<unknown>;

/**
 * Execute the trusted repository checks once before any fix worker starts. This
 * is an ecosystem-neutral dependency preflight: Node, Python, Rust, Go, and
 * custom verify manifests prove their actual toolchain/runtime instead of being
 * guessed from marker files. Existing test failures may still be fixed; only an
 * inability to execute the trusted verification runtime blocks worker edits.
 */
export async function collectFixRuntimePreflightIssues(
  projectPath: string,
  config: VerifyConfig,
  plan: TrustedVerifyPlan | undefined,
  verify: FixRuntimeVerifier = runDeterministicTester,
): Promise<string[]> {
  if (!plan || plan.commands.length === 0) return [];
  try {
    await verify(projectPath, config, plan.commands, plan.packageJsonByDirectory);
    return [];
  } catch (error) {
    return [
      `Trusted repository verification could not execute before fix workers started: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}
