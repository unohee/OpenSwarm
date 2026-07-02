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

// eslint-disable-next-line no-control-regex
const TERMINAL_ESCAPE_RE = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

function sanitizeMarkdownInput(md: string): string {
  return md.replace(TERMINAL_ESCAPE_RE, '').replace(CONTROL_RE, '');
}

function ensureConfigured(): void {
  if (configured) return;
  // marked-terminal styles headings/lists/code; with cli-highlight present it
  // syntax-highlights fenced code blocks. reflowText wraps prose to the terminal.
  marked.use(markedTerminal({ reflowText: true, tab: 2 }));
  configured = true;
}

/** Render markdown to an ANSI-styled string. Falls back to the raw text on error. */
export function renderMarkdown(md: string): string {
  if (!md) return '';
  const safeMd = sanitizeMarkdownInput(md);
  try {
    ensureConfigured();
    const out = marked.parse(safeMd);
    const text = typeof out === 'string' ? out : safeMd;
    return text.replace(/\s+$/, '');
  } catch {
    return safeMd;
  }
}
