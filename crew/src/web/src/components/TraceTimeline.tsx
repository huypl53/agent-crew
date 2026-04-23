import React, { useState } from 'react';
import type { FlatRow } from './TraceView.tsx';

// ── Time format helpers ────────────────────────────────────────────────────
function fmtTime(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDateTime(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function fmtDuration(ms: number | null): string {
  if (ms === null || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── Bar colours by kind ────────────────────────────────────────────────────
const BAR_COLORS: Record<string, string> = {
  task: 'bg-amber-500/70',
  message: 'bg-slate-500/50',
  agent: 'bg-violet-500/50',
  room: 'bg-blue-500/40',
};

const BAR_SELECTED: Record<string, string> = {
  task: 'bg-amber-400',
  message: 'bg-slate-300',
  agent: 'bg-violet-400',
  room: 'bg-blue-400',
};

// ── Props ──────────────────────────────────────────────────────────────────
interface Props {
  rows: FlatRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  timeBounds: { min: number; max: number };
}

// ── Tooltip ────────────────────────────────────────────────────────────────
function Tooltip({
  node,
  rect,
}: {
  node: FlatRow['node'];
  rect: DOMRect | null;
}) {
  if (!rect) return null;
  return (
    <div
      className="fixed z-50 bg-slate-800 border border-slate-600 rounded px-2.5 py-1.5 text-xs space-y-0.5 pointer-events-none shadow-lg"
      style={{ left: rect.left, top: rect.bottom + 4 }}
    >
      <div className="text-slate-200 font-medium truncate max-w-xs">
        {node.label}
      </div>
      {node.timestamp != null && (
        <div className="text-slate-400">{fmtDateTime(node.timestamp)}</div>
      )}
      {node.durationMs != null && (
        <div className="text-slate-400">
          Duration: {fmtDuration(node.durationMs)}
        </div>
      )}
      {node.status && (
        <div className="text-slate-400 capitalize">{String(node.status)}</div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export default function TraceTimeline({
  rows,
  selectedId,
  onSelect,
  timeBounds,
}: Props) {
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const [hoverNode, setHoverNode] = useState<FlatRow['node'] | null>(null);

  const { min, max } = timeBounds;
  const range = max - min || 1; // avoid divide-by-zero

  // Generate 5-6 tick marks
  const ticks: number[] = [];
  const tickCount = 6;
  for (let i = 0; i < tickCount; i++) {
    ticks.push(min + (range * i) / (tickCount - 1));
  }

  // Filter rows to only those with a timestamp
  const timedRows = rows.filter((r) => r.node.timestamp != null);

  if (timedRows.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500 text-xs">
        No timed events to display
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* Time axis header */}
      <div className="flex-shrink-0 border-b border-slate-700 h-6 relative">
        {ticks.map((t, i) => {
          const pct = ((t - min) / range) * 100;
          return (
            <span
              key={i}
              className="absolute text-[9px] text-slate-500 font-mono -translate-x-1/2 top-1"
              style={{ left: `${pct}%` }}
            >
              {fmtTime(t)}
            </span>
          );
        })}
      </div>

      {/* Scrollable bar area */}
      <div className="flex-1 overflow-y-auto relative">
        {rows.map((row) => {
          const { node } = row;
          if (node.timestamp == null) {
            // Spacer row (no bar) — maintains alignment with tree
            return <div key={node.id} className="h-6" />;
          }

          const startSec = node.timestamp;
          const durSec = node.durationMs != null ? node.durationMs / 1000 : 2; // min 2s for point events
          const endSec = startSec + durSec;

          const leftPct = ((startSec - min) / range) * 100;
          const widthPct = Math.max(0.5, ((endSec - startSec) / range) * 100);
          const isSelected = node.id === selectedId;

          return (
            <div
              key={node.id}
              className="h-6 flex items-center px-1 cursor-pointer"
              onClick={() => onSelect(node.id)}
              onMouseEnter={(e) => {
                setHoverRect(e.currentTarget.getBoundingClientRect());
                setHoverNode(node);
              }}
              onMouseLeave={() => {
                setHoverRect(null);
                setHoverNode(null);
              }}
            >
              <div
                className={`h-3.5 rounded-sm transition-colors ${
                  isSelected
                    ? (BAR_SELECTED[node.kind] ?? 'bg-emerald-400')
                    : (BAR_COLORS[node.kind] ?? 'bg-slate-600/50')
                }`}
                style={{
                  marginLeft: `${leftPct}%`,
                  width: `${widthPct}%`,
                  minWidth: '3px',
                }}
              />
            </div>
          );
        })}
      </div>

      {/* Tooltip */}
      {hoverNode && <Tooltip node={hoverNode} rect={hoverRect} />}
    </div>
  );
}
