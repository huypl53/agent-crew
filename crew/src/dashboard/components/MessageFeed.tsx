import React, { memo, useMemo, useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { FormattedMessage } from '../hooks/useFeed.ts';
import type { MessageKind, Message } from '../../shared/types.ts';
import { buildMessageTree, flattenTree, hasThreading } from '../hooks/useMessageTree.ts';

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

/** Convert FormattedMessage to a minimal Message shape for tree building. */
function toMessage(fm: FormattedMessage): Message {
  return {
    message_id: fm.id,
    from: fm.sender,
    room: fm.room,
    to: fm.target === 'ALL' ? null : fm.target,
    text: fm.text,
    kind: fm.kind as MessageKind,
    timestamp: fm.timestamp,
    sequence: parseInt(fm.id, 10),
    mode: 'pull',
    reply_to: fm.reply_to,
  };
}

export const MessageFeedPanel = memo(function MessageFeedPanel({ messages, roomFilter, height, enabledKinds }: MessageFeedPanelProps) {
  const maxLines = Math.max(1, height - 2);
  const title = roomFilter ? `Messages [${roomFilter}]` : 'Messages';
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);

  const allOn = enabledKinds.size === 6;
  const filterStr = allOn ? '' : ` T:${enabledKinds.has('task') ? 'on' : 'off'} D:${enabledKinds.has('completion') ? 'on' : 'off'} E:${enabledKinds.has('error') ? 'on' : 'off'} ?:${enabledKinds.has('question') ? 'on' : 'off'} S:${enabledKinds.has('status') ? 'on' : 'off'} C:${enabledKinds.has('chat') ? 'on' : 'off'}`;

  const filtered = useMemo(() =>
    (roomFilter ? messages.filter(m => m.room === roomFilter) : messages)
      .filter(m => enabledKinds.has(m.kind as MessageKind)),
    [messages, roomFilter, enabledKinds],
  );

  // Threaded mode: convert to Message[] and build tree
  const asMessages = useMemo(() => filtered.map(toMessage), [filtered]);
  const threaded = useMemo(() => hasThreading(asMessages), [asMessages]);

  const flatRows = useMemo(() => {
    if (!threaded) return null;
    const tree = buildMessageTree(asMessages);
    return flattenTree(tree, collapsed);
  }, [threaded, asMessages, collapsed]);

  const msgMap = useMemo(() => new Map(filtered.map(m => [m.id, m])), [filtered]);

  // Flat mode: question-response pairing
  const responseMap = useMemo(() => {
    if (threaded) return new Map<string, FormattedMessage | null>();
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
  }, [filtered, threaded]);

  const threadedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const resp of responseMap.values()) {
      if (resp) ids.add(resp.id);
    }
    return ids;
  }, [responseMap]);

  const flatVisible = useMemo(() =>
    threaded ? [] : filtered.filter(m => !threadedIds.has(m.id)).slice(-maxLines),
    [filtered, threadedIds, maxLines, threaded],
  );

  // 'c' to toggle collapse on cursor row; j/k to move cursor (threaded mode only)
  useInput(useCallback((input: string) => {
    if (!threaded || !flatRows) return;
    if (input === 'c') {
      const visibleRows = flatRows.slice(-maxLines);
      const row = visibleRows[cursor];
      if (row && row.hasChildren) {
        setCollapsed(prev => {
          const next = new Set(prev);
          if (next.has(row.nodeId)) next.delete(row.nodeId);
          else next.add(row.nodeId);
          return next;
        });
      }
    } else if (input === 'j') {
      setCursor(c => Math.min(c + 1, Math.min(flatRows.length, maxLines) - 1));
    } else if (input === 'k') {
      setCursor(c => Math.max(c - 1, 0));
    }
  }, [threaded, flatRows, cursor, maxLines]));

  // --- Threaded render ---
  if (threaded && flatRows) {
    const visible = flatRows.slice(-maxLines);
    const hiddenAbove = flatRows.length > maxLines ? flatRows.length - maxLines : 0;

    return (
      <Box flexDirection="column" borderStyle="single" height={height}>
        <Text bold> {title} [threaded]{filterStr && <Text dimColor>{filterStr}</Text>} </Text>
        {visible.length === 0 && <Text dimColor> No messages yet</Text>}
        {hiddenAbove > 0 && <Text dimColor> ↑ {hiddenAbove} more (j/k move, c collapse)</Text>}
        {visible.map((row, i) => {
          const fm = msgMap.get(row.message.message_id);
          if (!fm) return null;
          const badge = KIND_BADGES[fm.kind];
          const badgeColor = KIND_COLORS[fm.kind];
          const isCursor = i === cursor;
          return (
            <Text key={row.nodeId} wrap="truncate">
              {isCursor ? '>' : ' '}
              <Text dimColor>{row.prefix}</Text>
              <Text dimColor>{fm.timestamp}</Text>
              {badge && <Text color={badgeColor}> {badge}</Text>}
              {' '}<Text color={fm.roomColor}>[{fm.sender}@{fm.room}]</Text>
              {' '}→ {fm.target === 'ALL' ? <Text bold>ALL</Text> : <Text>{fm.target}</Text>}
              : {fm.text.replace(/[\n\r]/g, ' ')}
              {row.isCollapsed && row.hiddenCount > 0 && <Text dimColor> (+{row.hiddenCount})</Text>}
            </Text>
          );
        })}
      </Box>
    );
  }

  // --- Flat render (fallback when no reply_to) ---
  return (
    <Box flexDirection="column" borderStyle="single" height={height}>
      <Text bold> {title}{filterStr && <Text dimColor>{filterStr}</Text>} </Text>
      {flatVisible.length === 0 && <Text dimColor> No messages yet</Text>}
      {flatVisible.flatMap(msg => {
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
