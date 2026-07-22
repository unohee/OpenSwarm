// ContextBar — top line: gradient wordmark + provider/model · cwd · git branch
// (INT-1943). Replaces the plain StatusBar with a Claude-Code-style header.
import { Box, Text } from 'ink';
import Gradient from 'ink-gradient';
import { basename } from 'node:path';
import { theme, ICON, LOGO_GRADIENT } from '../theme.js';
import { sanitizeTerminalText } from '../sanitize.js';

export interface ContextBarProps {
  version?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  branch?: string;
}

export function ContextBar({ version, provider, model, cwd, branch }: ContextBarProps) {
  const right = [
    provider ? sanitizeTerminalText(model ? `${provider}:${model}` : provider) : null,
    cwd ? sanitizeTerminalText(basename(cwd)) : null,
    branch ? `${ICON.git}${sanitizeTerminalText(branch)}` : null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  return (
    <Box justifyContent="space-between">
      <Box>
        <Gradient colors={LOGO_GRADIENT}>OpenSwarm</Gradient>
        {version ? <Text color={theme.dim}>{` v${version}`}</Text> : null}
      </Box>
      {right ? <Text color={theme.dim}>{right}</Text> : null}
    </Box>
  );
}
