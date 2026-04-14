import { useState, useCallback, useRef } from 'react';
import type { Message } from '../../shared/types.ts';

const MAX_MESSAGES = 500;
const ROOM_COLORS = ['cyan', 'magenta', 'blue', 'green', 'yellow'] as const;

export interface FormattedMessage {
  id: string;
  timestamp: string;
  sender: string;
  room: string;
  target: string;
  text: string;
  kind: string;
  roomColor: typeof ROOM_COLORS[number];
}

export function useFeed() {
  const [messages, setMessages] = useState<FormattedMessage[]>([]);
  const seenIds = useRef(new Set<string>());
  const roomColorMap = useRef(new Map<string, typeof ROOM_COLORS[number]>());

  const getRoomColor = (room: string): typeof ROOM_COLORS[number] => {
    let c = roomColorMap.current.get(room);
    if (!c) { c = ROOM_COLORS[roomColorMap.current.size % ROOM_COLORS.length]!; roomColorMap.current.set(room, c); }
    return c;
  };

  const update = useCallback((rawMessages: Message[]) => {
    const sorted = [...rawMessages].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const newItems: FormattedMessage[] = [];
    for (const msg of sorted) {
      if (seenIds.current.has(msg.message_id)) continue;
      seenIds.current.add(msg.message_id);
      const d = new Date(msg.timestamp);
      const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      newItems.push({
        id: msg.message_id, timestamp: ts, sender: msg.from, room: msg.room,
        target: msg.to ?? 'ALL', text: msg.text, kind: msg.kind ?? 'chat',
        roomColor: getRoomColor(msg.room),
      });
    }
    if (newItems.length > 0) {
      setMessages(prev => {
        const combined = [...prev, ...newItems];
        if (combined.length > MAX_MESSAGES) {
          const kept = combined.slice(-MAX_MESSAGES);
          // Rebuild seenIds from kept messages — drops ids of evicted ones
          seenIds.current = new Set(kept.map(m => m.id));
          return kept;
        }
        return combined;
      });
    }
  }, []);

  return { messages, update };
}
