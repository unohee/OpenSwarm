// Minimal ambient types for marked-terminal v7 (no bundled declarations).
declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';

  interface MarkedTerminalOptions {
    reflowText?: boolean;
    width?: number;
    tab?: number | string;
    [key: string]: unknown;
  }
  /** Runtime export from marked-terminal v7, consumed by marked.use(). */
  export function markedTerminal(options?: MarkedTerminalOptions, highlightOptions?: unknown): MarkedExtension;
}
