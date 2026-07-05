// Per-stage wall-clock ceilings for the pair pipeline.
//
// A stage timeout of 0/undefined USED to mean "unlimited" (config default
// workerTimeoutMs/reviewerTimeoutMs = 0). base.ts / agenticLoop then never armed a
// kill timer, so a stalled CLI turn or agentic loop hung forever — and with
// maxConcurrentTasks=1 that wedged the WHOLE daemon (no slot ever freed). Never
// allow 0: floor to these ceilings. Generous vs observed runtimes (worker 2-5min,
// reviewer 40-140s) so real work is never cut, but a genuine stall is reclaimed and
// classified infra_error. (INT-2521)
const STAGE_TIMEOUT_DEFAULTS_MS: Readonly<Record<string, number>> = {
  worker: 20 * 60_000,
  reviewer: 6 * 60_000,
  tester: 6 * 60_000,
  documenter: 6 * 60_000,
  auditor: 6 * 60_000,
  'skill-documenter': 6 * 60_000,
};

/** Effective stage timeout: the configured value if >0, else the stage ceiling — never 0/unlimited. */
export function stageTimeoutMs(stage: string, configured: number | undefined): number {
  if (typeof configured === 'number' && configured > 0) return configured;
  return STAGE_TIMEOUT_DEFAULTS_MS[stage] ?? 10 * 60_000;
}
