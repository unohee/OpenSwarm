// WorkingIndicator — animated braille spinner + cycling Warhammer-40k loading
// line, recovered from the blessed TUI (INT-1813 follow-up). The spinner ticks
// ~120ms; the message rotates ~2.5s. Frame/message math lives in
// loadingMessages.ts (tested); this just drives the timer.
import { Text } from 'ink';
import { useState, useEffect } from 'react';
import { spinnerFrame, loadingMessage, LOADING_MESSAGES } from '../loadingMessages.js';
import { theme } from '../theme.js';

const TICK_MS = 120;

export interface WorkingIndicatorProps {
  /** Fixed starting message index (tests). Defaults to a random line per mount. */
  startIndex?: number;
}

export function WorkingIndicator({ startIndex }: WorkingIndicatorProps) {
  const [base] = useState(() => startIndex ?? Math.floor(Math.random() * LOADING_MESSAGES.length));
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text color={theme.dim}>
      <Text color={theme.accent}>{spinnerFrame(tick)}</Text>
      <Text>{` ${loadingMessage(tick, base)}…`}</Text>
    </Text>
  );
}
