// ============================================
// OpenSwarm - CLI Adapter Types
// Interface definitions for CLI tool adapters
// ============================================

import type { WorkerResult, ReviewResult } from '../agents/agentPair.js';

// Re-export for convenience
export type { WorkerResult, ReviewResult };

export type AdapterName = 'claude' | 'codex' | 'gpt' | 'local';

/**
 * Raw result from a CLI process execution
 */
export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Context for process registry tracking
 */
export interface ProcessContext {
  taskId: string;
  stage: string;
}

/**
 * Options for running a CLI adapter
 */
export interface CliRunOptions {
  prompt: string;
  cwd: string;
  timeoutMs?: number;
  model?: string;
  maxTurns?: number;
  onLog?: (line: string) => void;
  processContext?: ProcessContext;
  /** 시스템 프롬프트 (GPT/Local 에이전틱 루프에서 사용) */
  systemPrompt?: string;
}

/**
 * Describes what a CLI adapter can do
 */
export interface AdapterCapabilities {
  supportsStreaming: boolean;
  supportsJsonOutput: boolean;
  supportsModelSelection: boolean;
  managedGit: boolean;
  supportedSkills: string[];
}

/**
 * CLI adapter interface — all adapters must implement this
 */
export interface CliAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;

  /** Check if the CLI tool is installed and available */
  isAvailable(): Promise<boolean>;

  /** Build the shell command and args for execution */
  buildCommand(options: CliRunOptions): { command: string; args: string[] };

  /**
   * Parse incremental stdout chunks for live log streaming.
   * Returns the trailing incomplete buffer to carry into the next chunk.
   */
  parseStreamingChunk?(
    chunk: string,
    onLog: (line: string) => void,
    buffer?: string,
  ): string;

  /**
   * Optional direct execution (bypasses spawnCli shell spawn).
   * Used by adapters that call APIs directly instead of spawning a CLI process.
   */
  run?(options: CliRunOptions): Promise<CliRunResult>;

  /** Parse raw CLI output into a WorkerResult */
  parseWorkerOutput(raw: CliRunResult): WorkerResult;

  /** Parse raw CLI output into a ReviewResult */
  parseReviewerOutput(raw: CliRunResult): ReviewResult;
}
