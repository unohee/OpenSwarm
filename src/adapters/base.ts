// ============================================
// OpenSwarm - CLI Adapter Base
// Shared spawn logic for all CLI adapters
// ============================================

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { CliAdapter, CliRunOptions, CliRunResult } from './types.js';
import { parseCliStreamChunk } from '../agents/cliStreamParser.js';
import { registerProcess } from './processRegistry.js';
import { buildWorkerEnv } from './envPath.js';

/**
 * Spawn a CLI process using the given adapter and options.
 * Handles: temp file write, spawn with shell, timeout/SIGKILL,
 * stdout/stderr buffering, stream parsing via onLog, cleanup.
 */
export async function spawnCli(
  adapter: CliAdapter,
  options: CliRunOptions,
): Promise<CliRunResult> {
  // 어댑터가 직접 실행을 지원하면 shell spawn 대신 사용
  if (adapter.run) {
    return adapter.run(options);
  }

  const promptFile = `/tmp/openswarm-prompt-${Date.now()}.txt`;
  await fs.writeFile(promptFile, options.prompt);

  try {
    const { command, args } = adapter.buildCommand({
      ...options,
      // Pass the temp file path as the prompt so buildCommand can reference it
      prompt: promptFile,
    });

    const cmd = [command, ...args].join(' ');
    const startTime = Date.now();

    return await new Promise<CliRunResult>((resolve, reject) => {
      const proc = spawn(cmd, {
        shell: true,
        cwd: options.cwd,
        // Inject OpenSwarm's bundled node_modules/.bin (gives workers access
        // to `cxt` and other shipped CLIs) without touching the user's shell
        // PATH or ~/.claude/ config.
        env: buildWorkerEnv(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Register process for tracking if context provided
      if (options.processContext && proc.pid) {
        registerProcess({
          pid: proc.pid,
          taskId: options.processContext.taskId,
          stage: options.processContext.stage,
          model: options.model,
          projectPath: options.cwd,
          spawnedAt: startTime,
          lastActivityAt: startTime,
        }, proc);
      }

      let stdout = '';
      let stderr = '';
      let streamBuffer = '';

      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        if (options.onLog && adapter.capabilities.supportsStreaming) {
          streamBuffer = adapter.parseStreamingChunk
            ? adapter.parseStreamingChunk(text, options.onLog, streamBuffer)
            : parseCliStreamChunk(text, options.onLog, streamBuffer);
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      const timeoutMs = options.timeoutMs ?? 300000;
      let timer: NodeJS.Timeout | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          proc.kill('SIGKILL');
          reject(new Error(`${adapter.name} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        const durationMs = Date.now() - startTime;

        if (options.onLog && adapter.capabilities.supportsStreaming && streamBuffer.trim()) {
          streamBuffer = adapter.parseStreamingChunk
            ? adapter.parseStreamingChunk('\n', options.onLog, streamBuffer)
            : parseCliStreamChunk('\n', options.onLog, streamBuffer);
        }

        if (code !== 0 && code !== null) {
          const stderrSnippet = stderr.slice(0, 500);
          const stdoutSnippet = stdout.slice(0, 300);
          console.error(`[${adapter.name}] CLI exited with code ${code}`);
          console.error(`[${adapter.name}] stderr: ${stderrSnippet || '(empty)'}`);
          console.error(`[${adapter.name}] stdout (first 300): ${stdoutSnippet || '(empty)'}`);
          console.error(`[${adapter.name}] Duration: ${durationMs}ms, CWD: ${options.cwd}`);
          reject(new Error(`${adapter.name} CLI failed with code ${code}: ${stderrSnippet.slice(0, 200)}`));
          return;
        }

        resolve({ exitCode: code ?? 0, stdout, stderr, durationMs });
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(new Error(`${adapter.name} spawn error: ${err.message}`));
      });
    });
  } finally {
    try {
      await fs.unlink(promptFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}
