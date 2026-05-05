import React, { useEffect, useMemo, useState } from 'react';
import { get } from '../hooks/useApi.ts';
import type { PaneMirror } from '../types.ts';

interface Props {
  room: string | null;
  subscribe: (eventType: string, handler: (event: any) => void) => () => void;
}

const MAX_PANES = 24;
const MAX_CONTENT_CHARS = 3000;

function trimContent(input: string): string {
  if (input.length <= MAX_CONTENT_CHARS) return input;
  return input.slice(input.length - MAX_CONTENT_CHARS);
}

export default function PaneBoard({ room, subscribe }: Props) {
  const [panes, setPanes] = useState<PaneMirror[]>([]);

  useEffect(() => {
    if (!room) {
      setPanes([]);
      return;
    }
    get<{ room: string; panes: PaneMirror[] }>(`/rooms/${encodeURIComponent(room)}/pane-mirror`)
      .then((res) => setPanes((res.panes ?? []).slice(0, MAX_PANES)))
      .catch(() => setPanes([]));
  }, [room]);

  useEffect(() => {
    return subscribe('pane-mirror', (event) => {
      if (!room || event.room !== room) return;
      const next: PaneMirror = {
        room: String(event.room),
        agent: String(event.agent),
        pane: String(event.pane),
        status: (event.status as PaneMirror['status']) ?? 'unknown',
        typing_active: Boolean(event.typing_active),
        input_chars: Number(event.input_chars ?? 0),
        content: trimContent(String(event.content ?? '')),
        captured_at: String(event.captured_at ?? new Date().toISOString()),
      };
      setPanes((prev) => {
        const idx = prev.findIndex((p) => p.pane === next.pane);
        if (idx >= 0) {
          const clone = prev.slice();
          clone[idx] = next;
          return clone;
        }
        return [...prev, next].slice(-MAX_PANES);
      });
    });
  }, [room, subscribe]);

  const sorted = useMemo(
    () => panes.slice().sort((a, b) => a.agent.localeCompare(b.agent)),
    [panes],
  );

  if (!room) return null;

  return (
    <section className="border-b border-slate-200 dark:border-slate-700 px-3 py-2 bg-slate-50 dark:bg-slate-800/40">
      <div className="text-xs uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-2">Pane board</div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2 max-h-72 overflow-y-auto">
        {sorted.map((pane) => (
          <article key={pane.pane} className="rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-2">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-medium text-slate-700 dark:text-slate-200">{pane.agent}</span>
              <span className="text-slate-500 dark:text-slate-400">{pane.status}{pane.typing_active ? ` · typing ${pane.input_chars}` : ''}</span>
            </div>
            <pre className="text-[11px] leading-4 text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-words max-h-28 overflow-y-auto">{trimContent(pane.content)}</pre>
          </article>
        ))}
        {sorted.length === 0 && (
          <div className="text-xs text-slate-500 dark:text-slate-400">No pane mirror data yet.</div>
        )}
      </div>
    </section>
  );
}
