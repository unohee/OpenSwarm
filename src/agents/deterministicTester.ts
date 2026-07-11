import { resolveBaseRef } from '../support/worktreeManager.js';
import { discoverVerifyCommands } from '../verify/discover.js';
import { loadVerifyManifest } from '../verify/manifest.js';
import { runVerify } from '../verify/runner.js';
import type { TesterResult } from './tester.js';

/** Returns null only when the repository exposes no deterministic verify commands. */
export async function runDeterministicTester(projectPath: string): Promise<TesterResult | null> {
  const loaded = await loadVerifyManifest(projectPath);
  if (loaded.error) throw new Error(`verify-runner: ${loaded.error}`);
  const commands = loaded.manifest?.commands ?? await discoverVerifyCommands(projectPath);
  if (commands.length === 0) return null;

  const base = await resolveBaseRef(projectPath).catch((error) => {
    throw new Error(`verify-runner: failed to resolve base ref: ${error instanceof Error ? error.message : String(error)}`);
  });
  const evidence = await runVerify({ projectPath, commands, baseRef: base.ref });
  const infra = evidence.find((item) => item.headStatus === 'infra');
  if (infra) {
    throw new Error(`verify-runner: ${infra.command.name} infrastructure failure: ${infra.rawOutputTail}`);
  }
  const failures = evidence.filter((item) => item.newFailure);
  return {
    success: failures.length === 0,
    testsPassed: evidence.length - failures.length,
    testsFailed: failures.length,
    output: evidence.map((item) => `[${item.command.name}] ${item.rawOutputTail}`).join('\n'),
    failedTests: failures.map((item) => item.command.name),
    deterministic: true,
    verificationEvidence: evidence,
  };
}
