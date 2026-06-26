// ============================================
// OpenSwarm - Ink TUI entry (EPIC INT-1813 / INT-1934, wired in S9 INT-1942)
// Launches the Ink cockpit in the alternate screen buffer. This is the live
// `openswarm` chat front-end (replaced blessed in S9).
// ============================================

import { withFullScreen } from 'fullscreen-ink';
import { App } from './App.js';

export interface StartInkTuiOptions {
  version?: string;
  provider?: string;
  model?: string;
  /** Daemon HTTP port for the Pipeline/monitor tabs. */
  port?: number;
}

/**
 * Start the Ink TUI full-screen (enters the alternate screen on start, restores
 * the prior terminal contents on exit). Resolves when the user exits.
 */
export async function startInkTui(opts: StartInkTuiOptions = {}): Promise<void> {
  const app = withFullScreen(
    <App version={opts.version} provider={opts.provider} model={opts.model} port={opts.port} />,
    { exitOnCtrlC: true },
  );
  await app.start();
  await app.waitUntilExit();
}
