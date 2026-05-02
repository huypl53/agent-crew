import { useEffect, useState } from 'react';
import { useWebSocket } from './useWebSocket.ts';

type AgentStatus = 'idle' | 'busy' | 'dead' | 'thinking' | 'reading';

/** Track real-time agent statuses via WebSocket */
export function useAgentPresence(room: string | null) {
  const [presence, setPresence] = useState<Map<string, AgentStatus>>(new Map());
  const { subscribe } = useWebSocket();

  useEffect(() => {
    if (!room) {
      setPresence(new Map());
      return;
    }
    return subscribe('agent-status', (payload: { name: string; status: AgentStatus }) => {
      setPresence((prev) => {
        const next = new Map(prev);
        next.set(payload.name, payload.status);
        return next;
      });
    });
  }, [room, subscribe]);

  return presence;
}
