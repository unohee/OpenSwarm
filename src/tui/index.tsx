// ============================================
// OpenSwarm - Ink TUI entry (EPIC INT-1813 S1 / INT-1934)
// Launches the Ink app in the alternate screen buffer. Not yet wired into the
// `openswarm` bin — cli.ts adopts it once the cockpit lands (S3+). Present from
// S1 so the alt-screen render path is part of the build/type-check surface.
// ============================================

import { withFullScreen } from 'fullscreen-ink';
import { App } from './App.js';

/**
 * Start the Ink TUI full-screen (enters the alternate screen on start, restores
 * the prior terminal contents on exit). Resolves when the user exits.
 */
export async function startInkTui(version?: string): Promise<void> {
  const app = withFullScreen(<App version={version} />, { exitOnCtrlC: true });
  await app.start();
  await app.waitUntilExit();
}
