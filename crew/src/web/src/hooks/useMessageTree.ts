import type { Message } from '../types.ts';

export interface MessageNode {
  message: Message;
  children: MessageNode[];
}

export interface FlatRow {
  message: Message;
  prefix: string;
  nodeId: string;
  hasChildren: boolean;
  isCollapsed: boolean;
  hiddenCount: number;
}

export function buildMessageTree(messages: Message[]): MessageNode[] {
  const nodes = new Map<number, MessageNode>();
  const sorted = [...messages].sort((a, b) => a.sequence - b.sequence);
  for (const m of sorted) nodes.set(m.sequence, { message: m, children: [] });
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

export function flattenTree(roots: MessageNode[], collapsed: Set<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  function visit(node: MessageNode, depth: number, continuing: boolean[]) {
    const nodeId = String(node.message.sequence);
    const isCollapsed = collapsed.has(nodeId);
    const hasChildren = node.children.length > 0;
    const hiddenCount = isCollapsed ? countDescendants(node) : 0;
    rows.push({ message: node.message, prefix: buildPrefix(depth, continuing, hasChildren, isCollapsed), nodeId, hasChildren, isCollapsed, hiddenCount });
    if (!isCollapsed) {
      node.children.forEach((child, i) => {
        visit(child, depth + 1, [...continuing, i < node.children.length - 1]);
      });
    }
  }
  roots.forEach(r => visit(r, 0, []));
  return rows;
}

function buildPrefix(depth: number, continuing: boolean[], hasChildren: boolean, isCollapsed: boolean): string {
  const leaf = hasChildren && isCollapsed ? '▶ ' : '· ';
  if (depth === 0) return leaf;
  let p = '';
  for (let i = 0; i < depth - 1; i++) p += continuing[i] ? '│  ' : '   ';
  p += continuing[depth - 1] ? '├─' : '└─';
  return p + leaf;
}

function countDescendants(node: MessageNode): number {
  return node.children.reduce((n, c) => n + 1 + countDescendants(c), 0);
}

export function hasThreading(messages: Message[]): boolean {
  return messages.some(m => m.reply_to != null);
}
