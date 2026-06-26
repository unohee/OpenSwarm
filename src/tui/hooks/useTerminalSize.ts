// ============================================
// OpenSwarm - useTerminalSize (EPIC INT-1813 S3 / INT-1936)
// Portable terminal-size hook: reads stdout columns/rows and tracks 'resize'.
// Works under both withFullScreen (prod) and ink-testing-library (tests),
// unlike fullscreen-ink's useScreenSize which needs its provider context.
// ============================================

import { useStdout } from 'ink';
import { useEffect, useState } from 'react';

export interface TerminalSize {
  columns: number;
  rows: number;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return size;
}
