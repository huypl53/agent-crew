import type { Message } from '../../shared/types.ts';

export interface MessageNode {
  message: Message;
  children: MessageNode[];
}

export interface FlatRow {
  message: Message;
  prefix: string;
  nodeId: string;      // String(message.sequence)
  hasChildren: boolean;
  isCollapsed: boolean;
  hiddenCount: number; // non-zero only when collapsed
}

/** Build a message tree from a flat array. Root nodes have no reply_to; children are grouped by reply_to. */
export function buildMessageTree(messages: Message[]): MessageNode[] {
  const nodes = new Map<number, MessageNode>();
  // Sort by sequence so children always come after parents
  const sorted = [...messages].sort((a, b) => a.sequence - b.sequence);

  for (const m of sorted) {
    nodes.set(m.sequence, { message: m, children: [] });
  }

  const roots: MessageNode[] = [];
  for (const m of sorted) {
    const node = nodes.get(m.sequence)!;
    if (m.reply_to != null && nodes.has(m.reply_to)) {
      nodes.get(m.reply_to)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Flatten tree to a renderable row array, hiding children of collapsed nodes.
 * Each row gets an ASCII graph prefix based on depth + sibling position.
 *
 * Prefix format:
 *   depth=0:                `* `  (or `▶ ` if collapsed)
 *   depth=1 non-last child: `├─* `
 *   depth=1 last child:     `└─* `
 *   depth=2+ inherits ancestor │/space columns per continuing[] stack
 */
export function flattenTree(roots: MessageNode[], collapsed: Set<string>): FlatRow[] {
  const rows: FlatRow[] = [];

  function visit(node: MessageNode, depth: number, continuing: boolean[]) {
    const nodeId = String(node.message.sequence);
    const isCollapsed = collapsed.has(nodeId);
    const hasChildren = node.children.length > 0;
    const hiddenCount = isCollapsed ? countDescendants(node) : 0;
    const prefix = buildPrefix(depth, continuing, hasChildren, isCollapsed);

    rows.push({ message: node.message, prefix, nodeId, hasChildren, isCollapsed, hiddenCount });

    if (!isCollapsed) {
      for (let i = 0; i < node.children.length; i++) {
        const isLast = i === node.children.length - 1;
        visit(node.children[i]!, depth + 1, [...continuing, !isLast]);
      }
    }
  }

  for (const root of roots) {
    visit(root, 0, []);
  }

  return rows;
}

function buildPrefix(depth: number, continuing: boolean[], hasChildren: boolean, isCollapsed: boolean): string {
  const leaf = hasChildren && isCollapsed ? '▶ ' : '* ';
  if (depth === 0) return leaf;

  let prefix = '';
  // Draw ancestor columns (depth-1 ancestors above current node)
  for (let i = 0; i < depth - 1; i++) {
    prefix += continuing[i] ? '│  ' : '   ';
  }
  // Current node connector: is there a sibling after this one?
  const hasMoreSiblings = continuing[depth - 1];
  prefix += hasMoreSiblings ? '├─' : '└─';
  prefix += leaf;
  return prefix;
}

function countDescendants(node: MessageNode): number {
  let n = 0;
  for (const c of node.children) n += 1 + countDescendants(c);
  return n;
}

/** Returns true if any message in the array has a reply_to set. */
export function hasThreading(messages: Message[]): boolean {
  return messages.some(m => m.reply_to != null);
}
