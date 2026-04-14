import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { get } from '../hooks/useApi.ts';
import type { Task, TaskEvent } from '../types.ts';

// ── Time window options (ms) ──────────────────────────────────────────────
const WINDOWS = [
  { label: '15m', ms: 15 * 60 * 1000 },
  { label: '1h',  ms: 60 * 60 * 1000 },
  { label: '6h',  ms: 6 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
];
const DEFAULT_WINDOW = WINDOWS[1]!; // 1h

// ── Status colours (Tailwind bg classes) ─────────────────────────────────
const STATUS_BG: Record<string, string> = {
  active:      'bg-yellow-500',
  completed:   'bg-green-500',
  error:       'bg-red-500',
  interrupted: 'bg-orange-500',
  queued:      'bg-slate-500',
  sent:        'bg-slate-600',
  cancelled:   'bg-slate-700',
};

// ── Pure computation (ported from TUI TimelineView) ───────────────────────
interface Segment {
  status: string;
  startMs: number;
  endMs: number;
  taskId: number;
  summary: string;
}

interface AgentRow {
  agentName: string;
  segments: Segment[];
}

function buildAgentTimelines(tasks: Task[], events: TaskEvent[], windowMs: number): AgentRow[] {
  const now = Date.now();
  const windowStart = now - windowMs;

  const allAgents = new Set<string>();
  for (const t of tasks) if (t.assigned_to) allAgents.add(t.assigned_to);

  const rows: AgentRow[] = [];

  for (const agentName of Array.from(allAgents).sort()) {
    const agentTasks = tasks.filter(t => t.assigned_to === agentName);
    const segments: Segment[] = [];

    for (const task of agentTasks) {
      const evts = events
        .filter(e => e.task_id === task.id)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      if (evts.length === 0) {
        const startMs = new Date(task.created_at).getTime();
        const endMs = Math.max(new Date(task.updated_at).getTime(), startMs + 1000);
        if (endMs >= windowStart) {
          segments.push({ status: task.status, startMs, endMs, taskId: task.id, summary: task.summary });
        }
      } else {
        for (let i = 0; i < evts.length; i++) {
          const evt = evts[i]!;
          const nextEvt = evts[i + 1];
          const startMs = new Date(evt.timestamp).getTime();
          const endMs = nextEvt
            ? new Date(nextEvt.timestamp).getTime()
            : (evt.to_status === 'active' ? now : startMs + 1000);
          if (endMs >= windowStart) {
            segments.push({ status: evt.to_status, startMs, endMs, taskId: task.id, summary: task.summary });
          }
        }
      }
    }

    if (segments.length > 0) rows.push({ agentName, segments });
  }

  return rows;
}

// ── Main component ────────────────────────────────────────────────────────
export default function TimelineView() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [window_, setWindow] = useState(DEFAULT_WINDOW);
  const [zoom, setZoom] = useState(1); // >1 = stretched (zoom in), <1 = compressed
  const [tooltip, setTooltip] = useState<{ x: number; y: number; seg: Segment } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    try {
      const [t, e] = await Promise.all([
        get<Task[]>('/tasks?limit=500'),
        get<TaskEvent[]>('/tasks/events').catch(() => [] as TaskEvent[]),
      ]);
      setTasks(t);
      setEvents(e);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 10_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const rows = useMemo(
    () => buildAgentTimelines(tasks, events, window_.ms),
    [tasks, events, window_]
  );

  const windowStart = Date.now() - window_.ms;
  const windowEnd = Date.now();
  const windowMs = window_.ms;

  // Map a timestamp to a % position within the window
  const toPct = (ms: number) => Math.max(0, Math.min(100, ((ms - windowStart) / windowMs) * 100));

  // Time-axis tick labels (5 ticks)
  const ticks = Array.from({ length: 6 }, (_, i) => {
    const ms = windowStart + (windowMs * i) / 5;
    const d = new Date(ms);
    return { pct: (i / 5) * 100, label: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
  });

  const zoomIn  = () => setZoom(z => Math.min(z * 1.5, 8));
  const zoomOut = () => setZoom(z => Math.max(z / 1.5, 0.25));

  if (loading) return <div className="flex-1 flex items-center justify-center text-slate-500">Loading timeline…</div>;
  if (error)   return <div className="flex-1 flex items-center justify-center text-red-400">{error}</div>;
  if (rows.length === 0) return (
    <div className="flex-1 flex flex-col items-center justify-center text-slate-500 gap-2">
      <div>No task activity in this window</div>
      <div className="flex gap-2">
        {WINDOWS.map(w => (
          <button key={w.label} onClick={() => setWindow(w)}
            className={`px-3 py-1 text-xs rounded ${window_.label === w.label ? 'bg-slate-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}>
            {w.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-700 flex-shrink-0 flex-wrap">
        <span className="text-xs text-slate-500">Window:</span>
        {WINDOWS.map(w => (
          <button key={w.label} onClick={() => setWindow(w)}
            className={`px-2 py-0.5 text-xs rounded ${window_.label === w.label ? 'bg-slate-600 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
            {w.label}
          </button>
        ))}
        <div className="flex items-center gap-1 ml-2">
          <button onClick={zoomOut} className="px-2 py-0.5 text-xs rounded text-slate-400 hover:text-slate-200 font-mono">−</button>
          <span className="text-xs text-slate-500 w-10 text-center">{zoom.toFixed(1)}×</span>
          <button onClick={zoomIn}  className="px-2 py-0.5 text-xs rounded text-slate-400 hover:text-slate-200 font-mono">+</button>
        </div>
        <span className="text-xs text-slate-600 ml-auto">{rows.length} agent{rows.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Scrollable swimlane area */}
      <div className="flex-1 overflow-auto" ref={containerRef}>
        <div style={{ minWidth: `${zoom * 100}%` }} className="flex flex-col">
          {/* Time axis */}
          <div className="relative h-7 border-b border-slate-700 flex-shrink-0 ml-28">
            {ticks.map(t => (
              <span key={t.pct} className="absolute text-xs text-slate-500 -translate-x-1/2" style={{ left: `${t.pct}%`, top: '6px' }}>
                {t.label}
              </span>
            ))}
          </div>

          {/* Agent rows */}
          {rows.map(row => (
            <div key={row.agentName} className="flex items-center border-b border-slate-800 h-8 hover:bg-slate-800/30">
              {/* Label */}
              <div className="w-28 flex-shrink-0 px-2 text-xs text-slate-400 truncate" title={row.agentName}>
                {row.agentName}
              </div>
              {/* Bar track */}
              <div className="relative flex-1 h-5 bg-slate-800/40 rounded-sm mx-1">
                {row.segments.map((seg, i) => {
                  const left = toPct(seg.startMs);
                  const right = toPct(seg.endMs);
                  const width = Math.max(right - left, 0.3);
                  const bg = STATUS_BG[seg.status] ?? 'bg-slate-500';
                  return (
                    <div
                      key={i}
                      data-timeline-bar="true"
                      className={`absolute top-0.5 bottom-0.5 rounded-sm cursor-pointer opacity-80 hover:opacity-100 ${bg}`}
                      style={{ left: `${left}%`, width: `${width}%`, minWidth: '3px' }}
                      onMouseEnter={e => {
                        const rect = (e.target as HTMLElement).getBoundingClientRect();
                        setTooltip({ x: rect.left, y: rect.top, seg });
                      }}
                      onMouseLeave={() => setTooltip(null)}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 bg-slate-800 border border-slate-600 rounded px-3 py-2 text-xs shadow-lg pointer-events-none max-w-xs"
          style={{ left: tooltip.x + 12, top: tooltip.y - 8 }}
        >
          <div className="font-medium text-slate-200">#{tooltip.seg.taskId} · {tooltip.seg.status}</div>
          <div className="text-slate-400 mt-0.5 truncate">{tooltip.seg.summary}</div>
          <div className="text-slate-600 mt-1">
            {new Date(tooltip.seg.startMs).toLocaleTimeString()} → {new Date(tooltip.seg.endMs).toLocaleTimeString()}
          </div>
        </div>
      )}
    </div>
  );
}
