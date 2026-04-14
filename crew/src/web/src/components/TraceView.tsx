import React, { useState, useMemo, useCallback, useRef } from 'react';
import { useTraceTree } from '../hooks/useTraceTree.ts';
import type { TraceNode } from '../hooks/useTraceTree.ts';
import TraceDetailPanel from './TraceDetailPanel.tsx';

// ── Icon color by kind (from design tokens) ───────────────────────────
const ICON_BG: Record<string, string> = {
  root:    'bg-kind-root',
  room:    'bg-kind-room',
  agent:   'bg-kind-agent',
  task:    'bg-kind-task',
  message: 'bg-kind-message',
};

// ── Duration formatter ────────────────────────────────────────────────────
function fmtDuration(ms: number | null): string {
  if (ms === null || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

// ── Token formatter ─────────────────────────────────────────────────────────
function fmtTokens(n: number | null): string {
  if (n === null) return '—';
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// ── Flatten tree to rows for rendering ───────────────────────────────────
interface FlatRow { node: TraceNode; depth: number; hasChildren: boolean }

function flatten(node: TraceNode, depth: number, expandedIds: Set<string>): FlatRow[] {
  const row: FlatRow = { node, depth, hasChildren: node.children.length > 0 };
  const rows: FlatRow[] = [row];
  if (node.children.length > 0 && expandedIds.has(node.id)) {
    for (const child of node.children) {
      rows.push(...flatten(child, depth + 1, expandedIds));
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
  const { node, depth, hasChildren } = row;
  const iconBg = ICON_BG[node.kind] ?? 'bg-slate-600';

  return (
    <div
      role="row"
      tabIndex={0}
      onClick={() => onSelect(node.id)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(node.id); } }}
      className={[
        'flex flex-col h-11 px-3 py-1.5 cursor-pointer select-none outline-none transition-colors',
        selected ? 'bg-accentDim border-l-2 border-accent' : 'border-l-2 border-transparent',
        'hover:bg-accentDim',
      ].join(' ')}
      style={{ paddingLeft: `${depth * 16 + 12}px` }}
    >
      {/* Top line: icon + label + chevron */}
      <div className="flex items-center gap-2 min-w-0">
        {/* Icon square */}
        <div className={`w-5 h-5 rounded ${iconBg} flex-shrink-0`} />

        {/* Label */}
        <span className="text-sm text-text-primary truncate flex-1">{node.label}</span>

        {/* Chevron (right-aligned) */}
        {hasChildren && (
          <button
            onClick={e => { e.stopPropagation(); onToggle(node.id); }}
            className="text-text-secondary hover:text-text-primary flex-shrink-0"
          >
            {expanded ? '▾' : '▸'}
          </button>
        )}
      </div>

      {/* Bottom line: duration + tokens */}
      <div className="flex items-center gap-4 text-xs text-text-secondary pl-7 font-nums">
        {/* Duration */}
        <span className="flex items-center gap-1 opacity-60">
          <span>⏱</span>
          <span>{fmtDuration(node.durationMs)}</span>
        </span>

        {/* Tokens */}
        <span className="flex items-center gap-1 opacity-60">
          <span>◎</span>
          <span>{fmtTokens(node.tokensIn)} / {fmtTokens(node.tokensOut)}</span>
        </span>

        {/* Cost */}
        {node.cost !== null && (
          <span className="flex items-center gap-1 opacity-60">
            <span>$</span>
            <span>{node.cost.toFixed(2)}</span>
          </span>
        )}
      </div>

      {/* Vertical connector gutter (for child rows) */}
      {depth > 0 && (
        <div className="absolute left-0 top-0 bottom-0 w-px bg-border pointer-events-none" style={{ left: `${depth * 16 + 6}px` }} />
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────
export default function TraceView() {
  const { tree, loading, error } = useTraceTree();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() =>
    tree ? defaultExpanded(tree) : new Set()
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const allIds = useMemo(() => tree ? collectIds(tree) : new Set<string>(), [tree]);
  const counts = useMemo(() => tree ? countKinds(tree) : {}, [tree]);

  const rows = useMemo(() => {
    if (!tree) return [];
    return flatten(tree, 0, expandedIds);
  }, [tree, expandedIds]);

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
  const collapseAll = () => setExpandedIds(tree ? new Set([tree.id]) : new Set());

  if (loading) return <div className="flex-1 flex items-center justify-center text-text-muted">Loading trace…</div>;
  if (error)   return <div className="flex-1 flex items-center justify-center text-status-error">{error}</div>;
  if (!tree)   return <div className="flex-1 flex items-center justify-center text-text-muted">No trace data.</div>;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-2 border-b border-border bg-panel flex-shrink-0">
        <span className="text-sm font-medium text-text-primary">Trace</span>
        <div className="flex gap-3">
          <button onClick={collapseAll} className="text-text-secondary hover:text-text-primary text-sm">Collapse</button>
          <button onClick={expandAll}   className="text-text-secondary hover:text-text-primary text-sm">Expand</button>
        </div>
      </div>

      {/* 30/70 split */}
      <div className="flex flex-1 overflow-hidden">
        {/* LEFT — span tree */}
        <div ref={treeRef} className="w-[30%] overflow-y-auto border-r border-border" role="tree">
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
        <div className="w-[70%] overflow-hidden flex flex-col">
          <TraceDetailPanel node={selectedNode} />
        </div>
      </div>
    </div>
  );
}
