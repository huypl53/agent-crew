import React, { memo } from 'react';
import { Box, Text } from 'ink';
import type { FormattedMessage } from '../hooks/useFeed.ts';
import type { MessageKind } from '../../shared/types.ts';

const KIND_COLORS: Record<string, string> = {
  task: 'cyan', completion: 'green', error: 'red', question: 'yellow',
};
const KIND_BADGES: Record<string, string> = {
  task: '[TASK]', completion: '[DONE]', error: '[ERR]', question: '[?]',
};

interface MessageFeedPanelProps {
  messages: FormattedMessage[];
  roomFilter: string | null;
  height: number;
  enabledKinds: Set<MessageKind>;
}

export const MessageFeedPanel = memo(function MessageFeedPanel({ messages, roomFilter, height, enabledKinds }: MessageFeedPanelProps) {
  const maxLines = Math.max(1, height - 2);
  const filtered = (roomFilter ? messages.filter(m => m.room === roomFilter) : messages)
    .filter(m => enabledKinds.has(m.kind as MessageKind));
  const visible = filtered.slice(-maxLines);
  const title = roomFilter ? `Messages [${roomFilter}]` : 'Messages';

  const allOn = enabledKinds.size === 6;
  const filterStr = allOn ? '' : ` T:${enabledKinds.has('task') ? 'on' : 'off'} D:${enabledKinds.has('completion') ? 'on' : 'off'} E:${enabledKinds.has('error') ? 'on' : 'off'} ?:${enabledKinds.has('question') ? 'on' : 'off'} S:${enabledKinds.has('status') ? 'on' : 'off'} C:${enabledKinds.has('chat') ? 'on' : 'off'}`;

  return (
    <Box flexDirection="column" borderStyle="single" height={height}>
      <Text bold> {title}{filterStr && <Text dimColor>{filterStr}</Text>} </Text>
      {visible.length === 0 && <Text dimColor> No messages yet</Text>}
      {visible.map(msg => {
        const badge = KIND_BADGES[msg.kind];
        const badgeColor = KIND_COLORS[msg.kind];
        return (
          <Text key={msg.id} wrap="truncate">
            {' '}<Text dimColor>{msg.timestamp}</Text>
            {badge && <Text color={badgeColor}> {badge}</Text>}
            {' '}<Text color={msg.roomColor}>[{msg.sender}@{msg.room}]</Text>
            {' '}→ {msg.target === 'ALL' ? <Text bold>ALL</Text> : <Text>{msg.target}</Text>}
            : {msg.text.replace(/[\n\r]/g, ' ')}
          </Text>
        );
      })}
      {filtered.length > maxLines && <Text dimColor> ↑ {filtered.length - maxLines} more</Text>}
    </Box>
  );
});
