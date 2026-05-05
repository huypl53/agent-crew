import React, { useEffect, useMemo, useState } from 'react';
import { get } from '../hooks/useApi.ts';
import type { TraceSelection, TraceTimelineFilters, TraceTimelinePayload } from '../types.ts';
import {
  buildTraceDagViewModel,
  buildTraceTimelineViewModel,
  buildTraceWaterfallViewModel,
} from '../types.ts';

function fmtTs(value: string | null): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return '—';
  return new Date(ms).toLocaleString();
}

function relationLabel(rel: string): string {
  if (rel === 'reply_to') return 'reply';
  if (rel === 'status_transition') return 'status';
  if (rel === 'parent') return 'parent';
  return 'inferred';
}

export default function TraceView() {
  const [filters, setFilters] = useState<TraceTimelineFilters>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<TraceTimelinePayload | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'timeline' | 'waterfall' | 'graph'>('timeline');
  const [selection, setSelection] = useState<TraceSelection>({ turnId: null, spanId: null });

  useEffect(() => {
    const q = new URLSearchParams();
    if (filters.room) q.set('room', filters.room);
    if (filters.agent) q.set('agent', filters.agent);
    if (filters.status) q.set('status', filters.status);
    if (filters.from) q.set('from', filters.from);
    if (filters.to) q.set('to', filters.to);
    setLoading(true);
    setError(null);
    get<TraceTimelinePayload>(`/trace/timeline?${q.toString()}`)
      .then((data) => setPayload(data))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [filters]);

  const timeline = useMemo(() => (payload ? buildTraceTimelineViewModel(payload) : { rows: [] }), [payload]);
  const waterfall = useMemo(
    () => (payload ? buildTraceWaterfallViewModel(payload) : { min_start_ms: 0, max_end_ms: 0, total_ms: 0, rows: [] }),
    [payload],
  );
  const dag = useMemo(() => (payload ? buildTraceDagViewModel(payload) : { nodes: [], edges: [] }), [payload]);

  const toggle = (turnId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  };

  if (loading) return <div className="p-4 text-slate-400">Loading trace timeline…</div>;
  if (error) return <div className="p-4 text-rose-400">{error}</div>;

  const selectedTurn = timeline.rows.find((r) => r.turn.turn_id === selection.turnId) ?? null;
  const selectedSpan = payload?.spans.find((s) => s.span_id === selection.spanId) ?? null;

  return (
    <div className="flex-1 overflow-auto p-3 space-y-3">
      <div className="grid grid-cols-5 gap-2">
        <input placeholder="room" className="bg-slate-800 text-xs p-2 rounded" onChange={(e) => setFilters((f) => ({ ...f, room: e.target.value || undefined }))} />
        <input placeholder="agent" className="bg-slate-800 text-xs p-2 rounded" onChange={(e) => setFilters((f) => ({ ...f, agent: e.target.value || undefined }))} />
        <input placeholder="status" className="bg-slate-800 text-xs p-2 rounded" onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value || undefined }))} />
        <input type="datetime-local" className="bg-slate-800 text-xs p-2 rounded" onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value ? new Date(e.target.value).toISOString() : undefined }))} />
        <input type="datetime-local" className="bg-slate-800 text-xs p-2 rounded" onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value ? new Date(e.target.value).toISOString() : undefined }))} />
      </div>

      <div className="flex gap-2 text-xs">
        {(['timeline', 'waterfall', 'graph'] as const).map((m) => (
          <button key={m} onClick={() => setMode(m)} className={`px-2 py-1 rounded border ${mode === m ? 'bg-slate-700 border-slate-600' : 'bg-slate-900 border-slate-700'}`}>{m}</button>
        ))}
      </div>

      {mode === 'timeline' && timeline.rows.map((row) => {
        const isExpanded = expanded.has(row.turn.turn_id);
        return (
          <div key={row.turn.turn_id} className={`border rounded ${selection.turnId === row.turn.turn_id ? 'border-cyan-500' : 'border-slate-700'}`}>
            <button className="w-full text-left px-3 py-2 text-xs hover:bg-slate-800 flex items-center justify-between" onClick={() => { toggle(row.turn.turn_id); setSelection({ turnId: row.turn.turn_id, spanId: row.spans[0]?.span_id ?? null }); }}>
              <span>{isExpanded ? '▼' : '▶'} {row.turn.room} · {row.turn.agent ?? 'unknown'} · {row.turn.status}</span>
              <span className="text-slate-400">{fmtTs(row.turn.started_at)} → {fmtTs(row.turn.ended_at)}</span>
            </button>
            {isExpanded && (
              <div className="px-3 pb-3 text-xs space-y-2">
                <ul className="space-y-1">
                  {row.spans.map((span) => (
                    <li key={span.span_id} onClick={() => setSelection({ turnId: row.turn.turn_id, spanId: span.span_id })} className={`rounded p-2 cursor-pointer ${selection.spanId === span.span_id ? 'bg-cyan-900/50' : 'bg-slate-900'}`}>
                      <div>{span.span_id} · {span.status}</div>
                      <div className="text-slate-400">{fmtTs(span.started_at)} → {fmtTs(span.ended_at)}</div>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-1">
                  {row.links.map((link, idx) => (
                    <span key={`${link.source_span_id}-${idx}`} className="px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                      {relationLabel(link.relation)}: {link.source_span_id} → {link.target_span_id}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {mode === 'waterfall' && (
        <div className="space-y-1 text-xs">
          {waterfall.rows.map((row) => {
            const left = ((row.start_ms - waterfall.min_start_ms) / waterfall.total_ms) * 100;
            const width = Math.max(1, ((row.end_ms - row.start_ms) / waterfall.total_ms) * 100);
            return (
              <button key={row.row_id} onClick={() => setSelection({ turnId: row.turn_id, spanId: row.span_id })} className="w-full text-left bg-slate-900 rounded p-2 border border-slate-700 hover:border-slate-500">
                <div className="flex justify-between"><span>{row.label}</span><span>{row.duration_ms}ms</span></div>
                <div className="relative h-2 bg-slate-800 rounded mt-1">
                  <div className={`absolute h-2 rounded ${selection.spanId === row.span_id ? 'bg-cyan-400' : 'bg-indigo-400'}`} style={{ left: `${left}%`, width: `${width}%` }} />
                </div>
              </button>
            );
          })}
        </div>
      )}

      {mode === 'graph' && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="space-y-1">
            {dag.nodes.map((node) => (
              <button key={node.id} onClick={() => setSelection({ turnId: `${node.room}:${node.agent ?? 'unknown'}`, spanId: node.span_id })} className={`w-full text-left rounded border p-2 ${selection.spanId === node.span_id ? 'border-cyan-500 bg-cyan-900/30' : 'border-slate-700 bg-slate-900'}`}>
                <div>{node.span_id}</div>
                <div className="text-slate-400">{node.status} · {node.room} · {node.agent ?? 'unknown'}</div>
              </button>
            ))}
          </div>
          <div className="rounded border border-slate-700 p-2 bg-slate-900">
            <div className="font-medium mb-2">Edges</div>
            <div className="space-y-1">
              {dag.edges.map((edge) => (
                <div key={edge.id} className="text-slate-300">{relationLabel(edge.relation)}: {edge.source} → {edge.target}</div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="rounded border border-slate-700 p-3 text-xs bg-slate-900">
        <div className="font-medium mb-1">Details</div>
        {selectedSpan ? (
          <div className="space-y-1">
            <div>span: {selectedSpan.span_id}</div>
            <div>status: {selectedSpan.status}</div>
            <div>room/agent: {selectedSpan.room} / {selectedSpan.agent ?? 'unknown'}</div>
            <div>time: {fmtTs(selectedSpan.started_at)} → {fmtTs(selectedSpan.ended_at)}</div>
          </div>
        ) : selectedTurn ? (
          <div>turn: {selectedTurn.turn.turn_id}</div>
        ) : (
          <div className="text-slate-400">Select timeline row, waterfall bar, or graph node.</div>
        )}
      </div>
    </div>
  );
}
