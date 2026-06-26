// StatusBar — top bar: app identity + active provider/model (EPIC INT-1813 S3).
import { Box, Text } from 'ink';

export interface StatusBarProps {
  version?: string;
  provider?: string;
  model?: string;
}

export function StatusBar({ version, provider, model }: StatusBarProps) {
  const right = provider ? (model ? `${provider}:${model}` : provider) : '';
  return (
    <Box justifyContent="space-between">
      <Text color="cyan" bold>{`OpenSwarm${version ? ` v${version}` : ''}`}</Text>
      {right ? <Text dimColor>{right}</Text> : null}
    </Box>
  );
}
