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
  enabledKinds: Set<string>;
  loading: boolean;
  error: string | null;
  room: string | null;
  onReplySelect?: (msg: Message) => void;
}

export default function MessageFeed({ messages, enabledKinds, loading, error, room, onReplySelect }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  // Thread-collapse state: nodeIds whose children are hidden (existing threading feature)
  const [threadCollapsed, setThreadCollapsed] = useState<Set<string>>(new Set());
  // Row-expand state: message_ids whose full text is shown (nothing expanded by default)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Reset both states when room changes
  useEffect(() => {
    setThreadCollapsed(new Set());
    setExpandedIds(new Set());
  }, [room]);

  const toggleThread = (nodeId: string) => {
    setThreadCollapsed(prev => {
      const next = new Set(prev);
      next.has(nodeId) ? next.delete(nodeId) : next.add(nodeId);
      return next;
    });
  };

  const toggleExpand = (messageId: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(messageId) ? next.delete(messageId) : next.add(messageId);
      return next;
    });
  };

  // Apply kind filter before tree building; unknown kinds fall through as 'chat'
  const filtered = messages.filter(m =>
    enabledKinds.has(m.kind) || (!KIND_BADGES[m.kind] && enabledKinds.has('chat')),
  );

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

  const renderMessage = (
    msg: Message,
    prefix?: string,
    nodeId?: string,
    hasChildren?: boolean,
    isThreadCollapsed?: boolean,
    hiddenCount?: number,
  ) => {
    const badge = KIND_BADGES[msg.kind];
    const badgeColor = KIND_COLORS[msg.kind] ?? 'text-slate-400';
    const id = nodeId ?? msg.message_id;
    const isExpanded = expandedIds.has(msg.message_id);
    const snippet = msg.text.length > 120 ? msg.text.slice(0, 120) + '…' : msg.text;

    return (
      <div key={id} className="font-mono text-sm">
        {/* Collapsed row — click to expand/collapse text */}
        <div
          className="group flex gap-2 px-3 py-0.5 hover:bg-slate-800/50 cursor-pointer items-baseline"
          onClick={() => toggleExpand(msg.message_id)}
        >
          {prefix != null && (
            <span className="text-slate-600 select-none whitespace-pre flex-shrink-0">{prefix}</span>
          )}
          {hasChildren && (
            <button
              onClick={e => { e.stopPropagation(); toggleThread(id); }}
              className="text-slate-500 hover:text-slate-300 text-xs w-4 flex-shrink-0"
              title={isThreadCollapsed ? 'Expand thread' : 'Collapse thread'}
            >
              {isThreadCollapsed ? '▶' : '▼'}
            </button>
          )}
          {!hasChildren && prefix != null && <span className="w-4 flex-shrink-0" />}
          <span className="text-slate-500 text-xs flex-shrink-0">{fmtTime(msg.timestamp)}</span>
          {badge && <span className={`text-xs flex-shrink-0 ${badgeColor}`}>[{badge}]</span>}
          <span className="text-slate-400 flex-shrink-0">[{msg.from}→{msg.to ?? 'ALL'}]</span>
          <span className={`truncate ${isExpanded ? 'text-slate-400' : 'text-slate-200'}`}>{snippet}</span>
          {isThreadCollapsed && hiddenCount != null && hiddenCount > 0 && (
            <span className="text-slate-500 text-xs flex-shrink-0">(+{hiddenCount})</span>
          )}
          {/* Reply button — stopPropagation so it doesn't toggle expand */}
          {onReplySelect && (
            <button
              onClick={e => { e.stopPropagation(); onReplySelect(msg); }}
              className="ml-auto flex-shrink-0 text-slate-600 hover:text-slate-400 text-xs opacity-0 group-hover:opacity-100"
              title="Reply to this message"
            >
              ↩
            </button>
          )}
        </div>

        {/* Expanded full text */}
        {isExpanded && (
          <div className="px-3 pb-1 pl-8 text-slate-300 whitespace-pre-wrap text-xs leading-relaxed border-l-2 border-slate-700 ml-3">
            {msg.text}
          </div>
        )}
      </div>
    );
  };

  const threaded = hasThreading(filtered);

  if (threaded) {
    const tree = buildMessageTree(filtered);
    const rows = flattenTree(tree, threadCollapsed);
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
      {filtered.map(msg => renderMessage(msg))}
      <div ref={bottomRef} />
    </div>
  );
}
