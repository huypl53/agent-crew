import { useEffect, useRef, useCallback } from 'react';
import type { WsEvent } from '../types.ts';

type Handler = (event: WsEvent) => void;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<string, Set<Handler>>>(new Map());
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onmessage = (e: MessageEvent) => {
      let evt: WsEvent;
      try { evt = JSON.parse(e.data as string) as WsEvent; } catch { return; }
      const handlers = handlersRef.current.get(evt.type);
      handlers?.forEach(h => h(evt));
    };

    ws.onclose = () => {
      reconnectTimer.current = setTimeout(connect, 2000);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connect]);

  const subscribe = useCallback((eventType: string, handler: Handler) => {
    if (!handlersRef.current.has(eventType)) {
      handlersRef.current.set(eventType, new Set());
    }
    handlersRef.current.get(eventType)!.add(handler);
    return () => handlersRef.current.get(eventType)?.delete(handler);
  }, []);

  return { subscribe };
}
