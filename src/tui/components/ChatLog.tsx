// ChatLog — completed messages in <Static> (rendered once, no flicker) plus a
// live streaming area below (EPIC INT-1813 S4). This is the direct fix for the
// blessed flicker: React/Ink never redraws the settled history.
import { Box, Text, Static } from 'ink';
import type { ChatLine } from '../chatModel.js';

const ROLE_COLOR: Record<ChatLine['role'], string> = { user: 'cyan', assistant: 'white', system: 'yellow' };
const ROLE_LABEL: Record<ChatLine['role'], string> = { user: 'you', assistant: 'ai', system: 'sys' };

export interface ChatLogProps {
  history: ChatLine[];
  streaming: string | null;
}

export function ChatLog({ history, streaming }: ChatLogProps) {
  return (
    <Box flexDirection="column">
      <Static items={history}>
        {(line, i) => (
          <Box key={i} flexDirection="column" marginBottom={1}>
            <Text color={ROLE_COLOR[line.role]} bold>{ROLE_LABEL[line.role]}</Text>
            <Text>{line.content}</Text>
          </Box>
        )}
      </Static>
      {streaming !== null ? (
        <Box flexDirection="column">
          <Text color="white" bold>ai</Text>
          <Text>{streaming.length > 0 ? streaming : '…'}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
