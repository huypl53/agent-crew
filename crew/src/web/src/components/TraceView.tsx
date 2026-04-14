import React, { useState, useMemo, useCallback, useRef } from 'react';
import { useTraceTree } from '../hooks/useTraceTree.ts';
import type { TraceNode } from '../hooks/useTraceTree.ts';
import TraceDetailPanel from './TraceDetailPanel.tsx';

// ── Status dot colour ────────────────────────────────────────────────────
const STATUS_DOT: Record<string, string> = {
  active:  'bg-amber-400',
  busy:    'bg-amber-400',
  queued:  'bg-slate-400',
  idle:    'bg-slate-400',
  done:    'bg-emerald-500',
  error:   'bg-rose-500',
  dead:    'bg-rose-500',
  note:    'bg-slate-500',
};

// ── Kind badge colour ─────────────────────────────────────────────────────
const KIND_BADGE: Record<string, string> = {
  root:    'bg-slate-700 text-slate-300',
  room:    'bg-blue-900 text-blue-300',
  agent:   'bg-violet-900 text-violet-300',
  task:    'bg-amber-900 text-amber-300',
  message: 'bg-slate-800 text-slate-400',
};

// ── Duration formatter ────────────────────────────────────────────────────
function fmtDuration(ms: number | null): string {
  if (ms === null || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

// ── Flatten tree to rows for rendering ───────────────────────────────────
interface FlatRow { node: TraceNode; depth: number; hasChildren: boolean; maxSiblingMs: number }

function flatten(node: TraceNode, depth: number, expandedIds: Set<string>, siblingMaxMs: number): FlatRow[] {
  const row: FlatRow = { node, depth, hasChildren: node.children.length > 0, maxSiblingMs: siblingMaxMs };
  const rows: FlatRow[] = [row];
  if (node.children.length > 0 && expandedIds.has(node.id)) {
    const maxMs = Math.max(...node.children.map(c => c.durationMs ?? 0), 1);
    for (const child of node.children) {
      rows.push(...flatten(child, depth + 1, expandedIds, maxMs));
    }
  }
  return rows;
}

// ── Counter summary from tree ─────────────────────────────────────────────
function countKinds(node: TraceNode, counts: Record<string, number> = {}) {
  counts[node.kind] = (counts[node.kind] ?? 0) + 1;
  for (const c of node.children) countKinds(c, counts);
  return counts;
}

function collectIds(node: TraceNode, out: Set<string> = new Set()) {
  out.add(node.id);
  for (const c of node.children) collectIds(c, out);
  return out;
}

function defaultExpanded(node: TraceNode, out: Set<string> = new Set()): Set<string> {
  // Expand root and rooms by default; agents/tasks/messages collapsed
  if (node.kind === 'root' || node.kind === 'room') {
    out.add(node.id);
    for (const c of node.children) defaultExpanded(c, out);
  }
  return out;
}

// ── Row component ─────────────────────────────────────────────────────────
interface RowProps {
  row: FlatRow;
  selected: boolean;
  expanded: boolean;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}

function TraceRow({ row, selected, expanded, onToggle, onSelect }: RowProps) {
  const { node, depth, hasChildren, maxSiblingMs } = row;
  const dotColor = STATUS_DOT[node.status ?? ''] ?? 'bg-slate-600';
  const badge = KIND_BADGE[node.kind] ?? 'bg-slate-800 text-slate-400';
  const barPct = (node.durationMs !== null && maxSiblingMs > 0)
    ? Math.max(2, (node.durationMs / maxSiblingMs) * 100)
    : 0;

  return (
    <div
      role="row"
      tabIndex={0}
      onClick={() => onSelect(node.id)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(node.id); } }}
      className={[
        'flex flex-col h-6 cursor-pointer select-none outline-none',
        'hover:bg-slate-800/70',
        selected ? 'bg-slate-700 border-l-2 border-emerald-500' : 'border-l-2 border-transparent',
      ].join(' ')}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <div className="flex items-center gap-1.5 h-6 pr-3 min-w-0">
        {/* Caret */}
        <span
          className="text-slate-500 w-3 text-xs flex-shrink-0"
          onClick={e => { e.stopPropagation(); onToggle(node.id); }}
        >
          {hasChildren ? (expanded ? '▼' : '▶') : ' '}
        </span>

        {/* Status dot */}
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor}`} />

        {/* Kind badge */}
        <span className={`text-xs px-1 rounded font-mono flex-shrink-0 ${badge}`}>{node.kind}</span>

        {/* Label */}
        <span className="text-xs text-slate-200 font-mono truncate flex-1 min-w-0">{node.label}</span>

        {/* Duration */}
        <span className="text-xs text-slate-500 font-mono flex-shrink-0 ml-2">{fmtDuration(node.durationMs)}</span>
      </div>

      {/* Duration bar */}
      {barPct > 0 && (
        <div className="h-px mx-1 -mt-px mb-px">
          <div className="h-full bg-slate-600 rounded-full" style={{ width: `${barPct}%` }} />
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────
export default function TraceView() {
  const { root, loading, error } = useTraceTree();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() =>
    root ? defaultExpanded(root) : new Set()
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const allIds = useMemo(() => root ? collectIds(root) : new Set<string>(), [root]);
  const counts = useMemo(() => root ? countKinds(root) : {}, [root]);

  const rows = useMemo(() => {
    if (!root) return [];
    return flatten(root, 0, expandedIds, root.durationMs ?? 1);
  }, [root, expandedIds]);

  const selectedNode = useMemo(
    () => rows.find(r => r.node.id === selectedId)?.node ?? null,
    [rows, selectedId]
  );

  const toggle = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const expandAll  = () => setExpandedIds(new Set(allIds));
  const collapseAll = () => setExpandedIds(root ? new Set([root.id]) : new Set());

  if (loading) return <div className="flex-1 flex items-center justify-center text-slate-500">Loading trace…</div>;
  if (error)   return <div className="flex-1 flex items-center justify-center text-red-400">{error}</div>;
  if (!root)   return <div className="flex-1 flex items-center justify-center text-slate-500">No trace data.</div>;

  return (
    <div className="flex-1 flex flex-col overflow-hidden font-mono">
      {/* Top strip */}
      <div className="flex items-center gap-4 px-4 py-1.5 border-b border-slate-700 flex-shrink-0 text-xs text-slate-400">
        <span>{counts.agent ?? 0} agents</span>
        <span>·</span>
        <span>{counts.task ?? 0} tasks</span>
        <span>·</span>
        <span>{counts.message ?? 0} messages</span>
        <div className="ml-auto flex gap-2">
          <button onClick={expandAll}   className="px-2 py-0.5 rounded hover:text-slate-200">Expand all</button>
          <button onClick={collapseAll} className="px-2 py-0.5 rounded hover:text-slate-200">Collapse all</button>
        </div>
      </div>

      {/* 60/40 split */}
      <div className="flex flex-1 overflow-hidden">
        {/* LEFT — span tree */}
        <div ref={treeRef} className="w-3/5 overflow-y-auto border-r border-slate-700" role="tree">
          {rows.map(row => (
            <TraceRow
              key={row.node.id}
              row={row}
              selected={row.node.id === selectedId}
              expanded={expandedIds.has(row.node.id)}
              onToggle={toggle}
              onSelect={setSelectedId}
            />
          ))}
        </div>

        {/* RIGHT — detail panel */}
        <div className="w-2/5 overflow-hidden flex flex-col">
          <TraceDetailPanel node={selectedNode} />
        </div>
      </div>
    </div>
  );
}
