// Minimal ambient types for marked-terminal v7 (no bundled declarations).
declare module 'marked-terminal' {
  interface MarkedTerminalOptions {
    reflowText?: boolean;
    width?: number;
    tab?: number;
    [key: string]: unknown;
  }
  // Returns a marked extension object (passed to marked.use).
  export function markedTerminal(options?: MarkedTerminalOptions, highlightOptions?: unknown): unknown;
}
