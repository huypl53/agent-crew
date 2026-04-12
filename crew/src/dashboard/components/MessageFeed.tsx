import React, { memo, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { FormattedMessage } from '../hooks/useFeed.ts';
import type { MessageKind } from '../../shared/types.ts';

function parseTimestamp(ts: string): number {
  const [h, m, s] = ts.split(':').map(Number);
  return ((h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0)) * 1000;
}

const KIND_COLORS: Record<string, string> = {
  task: 'cyan', completion: 'green', error: 'red', question: 'yellow',
  interrupted: 'magenta', cancelled: 'gray',
};
const KIND_BADGES: Record<string, string> = {
  task: '[TASK]', completion: '[DONE]', error: '[ERR]', question: '[?]',
  interrupted: '[INT]', cancelled: '[CXL]',
};

interface MessageFeedPanelProps {
  messages: FormattedMessage[];
  roomFilter: string | null;
  height: number;
  enabledKinds: Set<MessageKind>;
}

export const MessageFeedPanel = memo(function MessageFeedPanel({ messages, roomFilter, height, enabledKinds }: MessageFeedPanelProps) {
  const maxLines = Math.max(1, height - 2);
  const title = roomFilter ? `Messages [${roomFilter}]` : 'Messages';

  const allOn = enabledKinds.size === 6;
  const filterStr = allOn ? '' : ` T:${enabledKinds.has('task') ? 'on' : 'off'} D:${enabledKinds.has('completion') ? 'on' : 'off'} E:${enabledKinds.has('error') ? 'on' : 'off'} ?:${enabledKinds.has('question') ? 'on' : 'off'} S:${enabledKinds.has('status') ? 'on' : 'off'} C:${enabledKinds.has('chat') ? 'on' : 'off'}`;

  const filtered = useMemo(() =>
    (roomFilter ? messages.filter(m => m.room === roomFilter) : messages)
      .filter(m => enabledKinds.has(m.kind as MessageKind)),
    [messages, roomFilter, enabledKinds],
  );

  const responseMap = useMemo(() => {
    const map = new Map<string, FormattedMessage | null>();
    const WINDOW_MS = 5 * 60 * 1000;

    for (let i = 0; i < filtered.length; i++) {
      const q = filtered[i]!;
      if (q.kind !== 'question') continue;

      let found: FormattedMessage | null = null;
      const qTime = parseTimestamp(q.timestamp);

      for (let j = i + 1; j < filtered.length; j++) {
        const r = filtered[j]!;
        if (r.room !== q.room) continue;
        const rTime = parseTimestamp(r.timestamp);
        if (rTime - qTime > WINDOW_MS) break;
        if (r.sender === q.target && (r.target === q.sender || r.target === 'ALL')) {
          found = r;
          break;
        }
      }

      map.set(q.id, found);
    }

    return map;
  }, [filtered]);

  const threadedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const resp of responseMap.values()) {
      if (resp) ids.add(resp.id);
    }
    return ids;
  }, [responseMap]);

  // Filter out threaded responses BEFORE slicing so they don't eat maxLines slots
  const visible = useMemo(() =>
    filtered.filter(m => !threadedIds.has(m.id)).slice(-maxLines),
    [filtered, threadedIds, maxLines],
  );

  return (
    <Box flexDirection="column" borderStyle="single" height={height}>
      <Text bold> {title}{filterStr && <Text dimColor>{filterStr}</Text>} </Text>
      {visible.length === 0 && <Text dimColor> No messages yet</Text>}
      {visible.flatMap(msg => {
        if (threadedIds.has(msg.id)) return [];

        const badge = KIND_BADGES[msg.kind];
        const badgeColor = KIND_COLORS[msg.kind];
        const elements = [
          <Text key={msg.id} wrap="truncate">
            {' '}<Text dimColor>{msg.timestamp}</Text>
            {badge && <Text color={badgeColor}> {badge}</Text>}
            {' '}<Text color={msg.roomColor}>[{msg.sender}@{msg.room}]</Text>
            {' '}→ {msg.target === 'ALL' ? <Text bold>ALL</Text> : <Text>{msg.target}</Text>}
            : {msg.text.replace(/[\n\r]/g, ' ')}
          </Text>
        ];

        if (msg.kind === 'question' && responseMap.has(msg.id)) {
          const resp = responseMap.get(msg.id);
          if (resp) {
            elements.push(
              <Text key={`${msg.id}-resp`} wrap="truncate">
                {'  '}<Text dimColor>└─ {resp.timestamp}</Text>
                {' '}<Text color={resp.roomColor}>{resp.sender}</Text>
                : {resp.text.replace(/[\n\r]/g, ' ')}
              </Text>
            );
          } else {
            const elapsed = Math.floor((parseTimestamp(new Date().toTimeString().slice(0, 8)) - parseTimestamp(msg.timestamp)) / 60000);
            const agoStr = elapsed > 0 ? `${elapsed}m ago` : 'just now';
            elements.push(
              <Text key={`${msg.id}-unans`} dimColor>
                {'  '}<Text color="yellow">└─ (unanswered — {agoStr})</Text>
              </Text>
            );
          }
        }

        return elements;
      })}
      {filtered.length - threadedIds.size > maxLines && <Text dimColor> ↑ {filtered.length - threadedIds.size - maxLines} more</Text>}
    </Box>
  );
});
