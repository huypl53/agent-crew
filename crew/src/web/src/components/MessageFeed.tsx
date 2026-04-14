import React, { useEffect, useRef, useState } from 'react';
import type { Message } from '../types.ts';
import { buildMessageTree, flattenTree, hasThreading } from '../hooks/useMessageTree.ts';

const KIND_COLORS: Record<string, string> = {
  task: 'text-cyan-400', completion: 'text-green-400', error: 'text-red-400',
  question: 'text-yellow-400', status: 'text-slate-400',
};
const KIND_BADGES: Record<string, string> = {
  task: 'TASK', completion: 'DONE', error: 'ERR', question: '?', status: 'STS',
};

function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts.slice(11, 19) || ts;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

interface Props {
  messages: Message[];
  loading: boolean;
  error: string | null;
  room: string | null;
}

export default function MessageFeed({ messages, loading, error, room }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Reset collapsed when room changes
  useEffect(() => { setCollapsed(new Set()); }, [room]);

  const threaded = hasThreading(messages);

  const toggleCollapse = (nodeId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(nodeId) ? next.delete(nodeId) : next.add(nodeId);
      return next;
    });
  };

  if (!room) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
        Select a room
      </div>
    );
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">Loading…</div>;
  }

  if (error) {
    return <div className="flex-1 flex items-center justify-center text-red-400 text-sm">{error}</div>;
  }

  const renderMessage = (msg: Message, prefix?: string, nodeId?: string, hasChildren?: boolean, isCollapsed?: boolean, hiddenCount?: number) => {
    const badge = KIND_BADGES[msg.kind];
    const badgeColor = KIND_COLORS[msg.kind] ?? 'text-slate-400';
    const id = nodeId ?? msg.message_id;

    return (
      <div key={id} className="flex gap-2 px-3 py-0.5 hover:bg-slate-800/50 group text-sm font-mono">
        {prefix != null && (
          <span className="text-slate-600 select-none whitespace-pre">{prefix}</span>
        )}
        {hasChildren && (
          <button
            onClick={() => toggleCollapse(id)}
            className="text-slate-500 hover:text-slate-300 text-xs w-4 flex-shrink-0"
            title={isCollapsed ? 'Expand' : 'Collapse'}
          >
            {isCollapsed ? '▶' : '▼'}
          </button>
        )}
        {!hasChildren && prefix != null && <span className="w-4 flex-shrink-0" />}
        <span className="text-slate-500 text-xs">{fmtTime(msg.timestamp)}</span>
        {badge && <span className={`text-xs ${badgeColor}`}>[{badge}]</span>}
        <span className="text-slate-400">[{msg.from}→{msg.to ?? 'ALL'}]</span>
        <span className="text-slate-200 break-all">{msg.text}</span>
        {isCollapsed && hiddenCount != null && hiddenCount > 0 && (
          <span className="text-slate-500 text-xs">(+{hiddenCount})</span>
        )}
      </div>
    );
  };

  if (threaded) {
    const tree = buildMessageTree(messages);
    const rows = flattenTree(tree, collapsed);
    return (
      <div className="flex-1 overflow-y-auto flex flex-col">
        <div className="flex-1" />
        {rows.map(row => renderMessage(row.message, row.prefix, row.nodeId, row.hasChildren, row.isCollapsed, row.hiddenCount))}
        <div ref={bottomRef} />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto flex flex-col">
      <div className="flex-1" />
      {messages.map(msg => renderMessage(msg))}
      <div ref={bottomRef} />
    </div>
  );
}
