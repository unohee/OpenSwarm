// ============================================
// OpenSwarm - Stage error classification helpers (INT-2424)
// ============================================
//
// runStage() must rethrow rate-limit/infra errors so run()'s top-level catch
// can classify them as 'rate_limited'/'infra_error' (INT-1906, INT-2010)
// instead of counting them toward the STUCK failure budget like a genuine
// bad edit. These helpers carry the StageResult runStage() already built
// onto the rethrown error, so run() can restore it into PipelineResult.stages
// instead of silently dropping the failed stage.

import type { StageResult } from './pairPipeline.js';
import { RateLimitError } from '../adapters/rateLimitError.js';
import { isInfraError } from '../adapters/errorClassification.js';

type ClassifiedStageError = Error & { stageResult?: StageResult };

/** Thrown when the pipeline is cancelled mid-run (project disable / manual stop). */
export class PipelineCancelledError extends Error {
  constructor() {
    super('Pipeline cancelled');
    this.name = 'PipelineCancelledError';
  }
}

export function isClassifiedStageError(error: unknown): boolean {
  return error instanceof RateLimitError || isInfraError(error);
}

/**
 * Attaches `stageResult` to `error` and rethrows it. `isInfraError()` also
 * classifies raw primitives (e.g. a rejected string) — assigning a property
 * onto one throws under ESM strict mode, so non-Error values are wrapped
 * first (preserving `.message`, which is all isInfraError()/RateLimitError
 * downstream care about).
 */
export function rethrowClassified(error: unknown, stageResult: StageResult): never {
  const err = error instanceof Error ? error : new Error(String(error));
  (err as ClassifiedStageError).stageResult = stageResult;
  throw err;
}

export function extractClassifiedStageResult(error: unknown): StageResult | undefined {
  return (error as ClassifiedStageError)?.stageResult;
}
