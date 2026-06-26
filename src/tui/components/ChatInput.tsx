// ChatInput — controlled single-line input driven by useInput (S4).
// Korean/IME caveat: terminals deliver committed code points to useInput, so
// typed/pasted Hangul appends fine; in-progress IME composition is terminal-
// dependent and not echoed mid-composition. Nav keys (Tab/arrows) are left for
// the App router; Enter submits, Backspace deletes.
import { Box, Text, useInput } from 'ink';

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
      // Leave navigation keys to the App-level router.
      if (key.tab || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.escape) return;
      if (input && !key.ctrl && !key.meta) onChange(value + input);
    },
    { isActive: active && !busy },
  );

  return (
    <Box>
      <Text color="cyan">{'> '}</Text>
      <Text>{value}</Text>
      {busy ? <Text dimColor> …working (Esc to leave)</Text> : <Text inverse> </Text>}
    </Box>
  );
}
