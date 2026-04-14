import { useState, useEffect, useCallback } from 'react';
import type { Message, WsEvent } from '../types.ts';
import { get } from './useApi.ts';

interface UseMessagesResult {
  messages: Message[];
  loading: boolean;
  error: string | null;
}

export function useMessages(
  room: string | null,
  subscribe: (eventType: string, handler: (e: WsEvent) => void) => () => void,
): UseMessagesResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch initial messages when room changes
  useEffect(() => {
    if (!room) { setMessages([]); return; }
    setLoading(true);
    setError(null);
    get<Message[]>(`/rooms/${encodeURIComponent(room)}/messages?limit=200`)
      .then(msgs => setMessages(msgs))
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [room]);

  // Subscribe to live WS message events
  const handleWsMessage = useCallback((evt: WsEvent) => {
    const msg = evt.message as Message | undefined;
    if (!msg || msg.room !== room) return;
    setMessages(prev => {
      if (prev.some(m => m.message_id === msg.message_id)) return prev;
      return [...prev, msg];
    });
  }, [room]);

  useEffect(() => {
    return subscribe('message', handleWsMessage);
  }, [subscribe, handleWsMessage]);

  return { messages, loading, error };
}
