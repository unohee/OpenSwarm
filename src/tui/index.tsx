// ============================================
// OpenSwarm - Ink TUI entry (EPIC INT-1813 / INT-1934, wired in S9 INT-1942)
// Launches the Ink cockpit in the alternate screen buffer. This is the live
// `openswarm` chat front-end (replaced blessed in S9).
// ============================================

import { withFullScreen } from 'fullscreen-ink';
import { App } from './App.js';
import type { ChatLine } from './chatModel.js';

export interface StartInkTuiOptions {
  version?: string;
  provider?: string;
  model?: string;
  /** Daemon HTTP port for the Pipeline/monitor tabs. */
  port?: number;
  cwd?: string;
  branch?: string;
  /** Chat session id to save under (resume reuses an existing id). (INT-2014) */
  sessionId?: string;
  /** Conversation restored from a resumed session. (INT-2014) */
  initialHistory?: ChatLine[];
  /** Session goal restored from a resumed session. (INT-2014) */
  goal?: string;
}

/**
 * Start the Ink TUI full-screen (enters the alternate screen on start, restores
 * the prior terminal contents on exit). Resolves when the user exits.
 */
export async function startInkTui(opts: StartInkTuiOptions = {}): Promise<void> {
  const app = withFullScreen(
    <App
      version={opts.version}
      provider={opts.provider}
      model={opts.model}
      port={opts.port}
      cwd={opts.cwd}
      branch={opts.branch}
      sessionId={opts.sessionId}
      initialHistory={opts.initialHistory}
      goal={opts.goal}
    />,
    { exitOnCtrlC: true },
  );
  await app.start();
  await app.waitUntilExit();
}
