import { unlinkSync } from 'node:fs';

export function cleanupDaemonPid(isDaemon: boolean, pidFile: string): void {
  if (!isDaemon) return;
  try {
    unlinkSync(pidFile);
  } catch {
    // Missing/already-cleaned PID files are harmless.
  }
}

export interface ShutdownHandlerOptions {
  isDaemon: boolean;
  pidFile: string;
  stop: () => Promise<void>;
  exit: (code: number) => void;
  log?: (message: string, error?: unknown) => void;
}

/** Return one shared shutdown promise so repeated signals cannot race cleanup. */
export function createShutdownHandler(options: ShutdownHandlerOptions): (signal: string) => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return (signal: string): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      options.log?.(`\nReceived ${signal}, shutting down...`);
      let exitCode = 0;
      try {
        await options.stop();
      } catch (error) {
        exitCode = 1;
        options.log?.('Failed to stop service cleanly:', error);
      } finally {
        cleanupDaemonPid(options.isDaemon, options.pidFile);
        options.exit(exitCode);
      }
    })();
    return inFlight;
  };
}
