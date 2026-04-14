import React from 'react';
import type { TraceNode } from '../types.ts';

interface Props {
  nodes: TraceNode[];
  onSelect: (node: TraceNode) => void;
}

export default function Breadcrumb({ nodes, onSelect }: Props) {
  if (nodes.length === 0) return null;

  return (
    <nav className="flex items-center gap-2 px-3 py-2 border-b border-border text-xs">
      {nodes.map((node, i) => (
        <React.Fragment key={node.id}>
          {i > 0 && <span className="text-text-muted">›</span>}
          <button
            onClick={() => onSelect(node)}
            className={`hover:text-text-primary transition-colors ${
              i === nodes.length - 1 ? 'text-text-primary font-medium' : 'text-text-secondary'
            }`}
          >
            {i === 0 && node.kind === 'root' ? 'Home' : node.label}
          </button>
        </React.Fragment>
      ))}
    </nav>
  );
}
