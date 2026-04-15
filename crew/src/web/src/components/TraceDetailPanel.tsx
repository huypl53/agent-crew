// TODO: replace with track C real panel
import React from 'react';
import type { TraceNode } from '../hooks/useTraceTree.ts';

export default function TraceDetailPanel({ node }: { node: TraceNode | null }) {
  if (!node) return <div className="p-4 text-slate-500 text-sm">Select a node to inspect.</div>;
  return (
    <pre className="p-4 text-xs text-slate-300 font-mono whitespace-pre-wrap overflow-auto h-full">
      {JSON.stringify(node, null, 2)}
    </pre>
  );
}
