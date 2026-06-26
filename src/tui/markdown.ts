// ============================================
// OpenSwarm - Markdown → ANSI renderer (INT-1943)
// Renders assistant messages as terminal-styled markdown (bold/lists/code with
// syntax highlight) via marked + marked-terminal. Pure string → string, so it
// is unit-testable and framework-agnostic (used inside an Ink <Text>).
// ============================================

import { marked } from 'marked';
// marked-terminal has no bundled type declarations; see src/types/marked-terminal.d.ts.
import { markedTerminal } from 'marked-terminal';

let configured = false;

function ensureConfigured(): void {
  if (configured) return;
  // marked-terminal styles headings/lists/code; with cli-highlight present it
  // syntax-highlights fenced code blocks. reflowText wraps prose to the terminal.
  marked.use(markedTerminal({ reflowText: true, tab: 2 }) as Parameters<typeof marked.use>[0]);
  configured = true;
}

/** Render markdown to an ANSI-styled string. Falls back to the raw text on error. */
export function renderMarkdown(md: string): string {
  if (!md) return '';
  try {
    ensureConfigured();
    const out = marked.parse(md);
    const text = typeof out === 'string' ? out : md;
    return text.replace(/\s+$/, '');
  } catch {
    return md;
  }
}
