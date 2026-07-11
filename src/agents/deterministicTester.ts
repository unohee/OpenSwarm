import { resolveBaseRef } from '../support/worktreeManager.js';
import { discoverVerifyCommands } from '../verify/discover.js';
import { loadVerifyManifest } from '../verify/manifest.js';
import { runVerify } from '../verify/runner.js';
import type { TesterResult } from './tester.js';
import type { VerifyConfig } from '../core/types.js';
import type { VerifyCommand } from '../verify/manifest.js';
import { isInfraError } from '../adapters/errorClassification.js';

export async function loadTrustedVerifyCommands(projectPath: string, config: VerifyConfig): Promise<VerifyCommand[]> {
  if (!config.enabled) return [];
  const loaded = await loadVerifyManifest(projectPath);
  // A checked-in manifest error is a task/configuration failure, not transient
  // infrastructure: fail closed instead of silently falling back to an LLM.
  if (loaded.error) throw new Error(`verify-config: ${loaded.error}`);
  return (loaded.manifest?.commands ?? await discoverVerifyCommands(projectPath)).slice(0, config.maxCommands);
}

/** Returns null only when the repository exposes no deterministic verify commands. */
export async function runDeterministicTester(
  projectPath: string,
  config: VerifyConfig,
  trustedCommands?: VerifyCommand[],
): Promise<TesterResult | null> {
  if (!config.enabled) return null;
  const commands = trustedCommands ?? await loadTrustedVerifyCommands(projectPath, config);
  if (commands.length === 0) return null;

  const base = await resolveBaseRef(projectPath).catch((error) => {
    throw new Error(`verify-runner: failed to resolve base ref: ${error instanceof Error ? error.message : String(error)}`);
  });
  const evidence = await runVerify({ projectPath, commands, baseRef: base.ref });
  const infra = evidence.find((item) => item.headStatus === 'infra'
    || (item.headStatus === 'fail' && item.baseStatus === 'infra'));
  if (infra) {
    throw new Error(`verify-runner: ${infra.command.name} infrastructure failure: ${infra.rawOutputTail}`);
  }
  const headFailures = evidence.filter((item) => item.headStatus === 'fail');
  const newFailures = headFailures.filter((item) => item.newFailure);
  return {
    success: !config.blockOnNewFailures || newFailures.length === 0,
    testsPassed: evidence.filter((item) => item.headStatus === 'pass').length,
    testsFailed: headFailures.length,
    output: evidence.map((item) => `[${item.command.name}] ${item.rawOutputTail}`).join('\n'),
    failedTests: headFailures.map((item) => item.command.name),
    deterministic: true,
    verificationEvidence: evidence,
  };
}

export async function runTesterWithVerification(options: {
  projectPath: string;
  verify?: VerifyConfig;
  trustedCommands?: VerifyCommand[];
  fallback: () => Promise<TesterResult>;
  onInfra?: (error: unknown) => void;
}): Promise<TesterResult> {
  if (options.verify?.enabled) {
    try {
      const deterministic = await runDeterministicTester(options.projectPath, options.verify, options.trustedCommands);
      if (deterministic) return deterministic;
    } catch (error) {
      if (!isInfraError(error)) throw error;
      options.onInfra?.(error);
    }
  }
  return await options.fallback();
}
