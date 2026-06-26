// ChatInput — bordered prompt box, Claude-Code style (INT-1943).
// Controlled single-line input via useInput. Korean/IME caveat: terminals
// deliver committed code points, so typed/pasted Hangul appends fine; in-flight
// IME composition is terminal-dependent. Nav keys (Tab/arrows) are left to the
// App router; Enter submits, Backspace deletes.
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { theme, ICON } from '../theme.js';

export interface ChatInputProps {
  value: string;
  active: boolean;
  busy?: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}

export function ChatInput({ value, active, busy, onChange, onSubmit }: ChatInputProps) {
  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit(value);
        return;
      }
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
        return;
      }
      if (key.tab || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.escape) return;
      if (input && !key.ctrl && !key.meta) onChange(value + input);
    },
    { isActive: active && !busy },
  );

  return (
    <Box borderStyle="round" borderColor={active ? theme.borderActive : theme.border} paddingX={1}>
      {busy ? (
        <Text color={theme.dim}>
          <Spinner type="dots" />
          <Text>{' working… (Esc to leave)'}</Text>
        </Text>
      ) : (
        <Box>
          <Text color={theme.accent}>{`${ICON.prompt} `}</Text>
          {value ? <Text>{value}</Text> : <Text color={theme.dim}>{'type a message…   / for commands'}</Text>}
          {active ? <Text inverse> </Text> : null}
        </Box>
      )}
    </Box>
  );
}
