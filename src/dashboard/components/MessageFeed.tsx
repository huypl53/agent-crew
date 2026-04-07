import React from 'react';
import { Box, Text } from 'ink';
import type { FormattedMessage } from '../hooks/useFeed.ts';

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
}

export function MessageFeedPanel({ messages, roomFilter, height }: MessageFeedPanelProps) {
  const maxLines = Math.max(1, height - 2);
  const filtered = roomFilter ? messages.filter(m => m.room === roomFilter) : messages;
  const visible = filtered.slice(-maxLines);
  const title = roomFilter ? `Messages [${roomFilter}]` : 'Messages';

  return (
    <Box flexDirection="column" borderStyle="single" height={height}>
      <Text bold> {title} </Text>
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
}
