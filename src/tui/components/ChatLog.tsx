// ChatLog — Claude-Code-style conversation (INT-1943).
// Finalized messages render once in <Static> (no flicker); assistant text is
// markdown-rendered. A live area below shows the streaming reply + inline tool
// activity + a spinner while the agent works.
import { Box, Text, Static } from 'ink';
import Spinner from 'ink-spinner';
import type { ChatLine } from '../chatModel.js';
import { renderMarkdown } from '../markdown.js';
import { theme, ICON } from '../theme.js';

const ROLE_COLOR: Record<ChatLine['role'], string> = {
  user: theme.user,
  assistant: theme.assistant,
  system: theme.system,
};
const ROLE_LABEL: Record<ChatLine['role'], string> = {
  user: 'you',
  assistant: 'openswarm',
  system: 'system',
};
const ROLE_ICON: Record<ChatLine['role'], string> = {
  user: ICON.user,
  assistant: ICON.assistant,
  system: ICON.system,
};

function Message({ line }: { line: ChatLine }) {
  const body = line.role === 'assistant' ? renderMarkdown(line.content) : line.content;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={ROLE_COLOR[line.role]} bold>{`${ROLE_ICON[line.role]} ${ROLE_LABEL[line.role]}`}</Text>
      <Box paddingLeft={2}>
        <Text>{body}</Text>
      </Box>
    </Box>
  );
}

export interface ChatLogProps {
  history: ChatLine[];
  streaming: string | null;
  /** Recent tool-activity lines shown under the in-flight reply. */
  activity?: string[];
  busy?: boolean;
}

export function ChatLog({ history, streaming, activity = [], busy }: ChatLogProps) {
  const live = streaming !== null || busy;
  return (
    <Box flexDirection="column">
      <Static items={history}>{(line, i) => <Message key={i} line={line} />}</Static>
      {live ? (
        <Box flexDirection="column">
          <Text color={theme.assistant} bold>{`${ICON.assistant} ${ROLE_LABEL.assistant}`}</Text>
          <Box flexDirection="column" paddingLeft={2}>
            {activity.slice(-5).map((line, i) => (
              <Text key={i} color={theme.dim}>{`${ICON.tool} ${line}`}</Text>
            ))}
            {streaming ? <Text>{streaming}</Text> : null}
            {busy ? (
              <Text color={theme.dim}>
                <Spinner type="dots" />
                <Text>{' working…'}</Text>
              </Text>
            ) : null}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
