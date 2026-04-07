import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type { Agent, Room } from '../../shared/types.ts';
import type { AgentStatusEntry } from './useStatus.ts';

export interface TreeNode {
  type: 'room' | 'agent';
  id: string;
  label: string;
  memberCount?: number;
  collapsed?: boolean;
  agentName?: string;
  role?: string;
  secondary?: boolean;
}

/** Pure function: builds the flat node list from agents/rooms. Status is NOT baked in — read it at render time. Exported for testing. */
export function buildTree(
  agents: Record<string, Agent>,
  rooms: Record<string, Room>,
  collapsedRooms: Set<string>,
): TreeNode[] {
  const nodes: TreeNode[] = [];

  for (const roomName of Object.keys(rooms).sort()) {
    const room = rooms[roomName]!;
    nodes.push({
      type: 'room', id: `room:${roomName}`, label: roomName,
      memberCount: room.members.length,
      collapsed: collapsedRooms.has(roomName),
    });
    if (!collapsedRooms.has(roomName)) {
      for (const memberName of room.members) {
        const agent = agents[memberName];
        if (!agent) continue;
        const isPrimary = agent.rooms[0] === roomName;
        const nodeId = isPrimary ? `agent:${memberName}` : `agent:${memberName}:${roomName}`;
        nodes.push({
          type: 'agent', id: nodeId, label: memberName,
          agentName: memberName, role: agent.role,
          secondary: !isPrimary,
        });
      }
    }
  }

  const unassigned = Object.values(agents).filter(a => !a.rooms || a.rooms.length === 0);
  if (unassigned.length > 0) {
    nodes.push({
      type: 'room', id: 'room:__unassigned__',
      label: '── Unassigned ──',
      memberCount: unassigned.length,
      collapsed: collapsedRooms.has('__unassigned__'),
    });
    if (!collapsedRooms.has('__unassigned__')) {
      for (const agent of unassigned) {
        nodes.push({
          type: 'agent', id: `agent:${agent.name}`,
          label: agent.name, agentName: agent.name,
          role: agent.role,
        });
      }
    }
  }
  return nodes;
}

export interface UseTreeReturn {
  nodes: TreeNode[];
  selectedIndex: number;
  selectedNode: TreeNode | null;
  selectedAgentName: string | null;
  selectedRoomName: string | null;
  moveUp: () => void;
  moveDown: () => void;
  moveToTop: () => void;
  moveToBottom: () => void;
  toggleCollapse: () => void;
}

export function useTree(
  agents: Record<string, Agent>,
  rooms: Record<string, Room>,
  statuses: Map<string, AgentStatusEntry>,
): UseTreeReturn {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedRooms, setCollapsedRooms] = useState<Set<string>>(new Set());
  const autoSelectRef = useRef(true);
  const lastMostRecentRef = useRef<string | null>(null);

  // Tree structure only depends on agents/rooms/collapsed — NOT statuses
  const nodes = useMemo(() => buildTree(agents, rooms, collapsedRooms), [agents, rooms, collapsedRooms]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Auto-select most recently active agent — only on STATUS changes, not every render
  const statusChangeKey = useMemo(() => {
    let mostRecent: string | null = null;
    let mostRecentTime = 0;
    for (const [name, entry] of statuses.entries()) {
      if (entry.lastChange > mostRecentTime) { mostRecentTime = entry.lastChange; mostRecent = name; }
    }
    return mostRecent;
  }, [statuses]);

  useEffect(() => {
    if (!autoSelectRef.current || !statusChangeKey) return;
    if (statusChangeKey !== lastMostRecentRef.current) {
      lastMostRecentRef.current = statusChangeKey;
      const idx = nodes.findIndex(n => n.type === 'agent' && n.agentName === statusChangeKey);
      if (idx >= 0) setSelectedId(nodes[idx]!.id);
    }
  }, [statusChangeKey, nodes]);

  // Resolve selected index from selectedId — pure derivation, no setState
  let selectedIndex = -1;
  if (selectedId) {
    const idx = nodes.findIndex(n => n.id === selectedId);
    if (idx >= 0) selectedIndex = idx;
  }
  if (selectedIndex < 0 && nodes.length > 0) {
    const first = nodes.findIndex(n => n.type === 'agent');
    selectedIndex = first >= 0 ? first : 0;
  }
  if (selectedIndex >= nodes.length) selectedIndex = Math.max(0, nodes.length - 1);

  // Lazily initialize selectedId on first render with nodes
  useEffect(() => {
    if (selectedId === null && nodes.length > 0) {
      const first = nodes.findIndex(n => n.type === 'agent');
      const idx = first >= 0 ? first : 0;
      setSelectedId(nodes[idx]?.id ?? null);
    }
  }, [nodes, selectedId]);

  const selectedNode = nodes[selectedIndex] ?? null;
  const selectedAgentName = selectedNode?.type === 'agent' ? (selectedNode.agentName ?? null) : null;

  const selectedRoomName = useMemo(() => {
    if (!selectedNode) return null;
    if (selectedNode.type === 'room') return selectedNode.label;
    for (let i = selectedIndex - 1; i >= 0; i--) {
      if (nodes[i]?.type === 'room') return nodes[i]!.label;
    }
    return null;
  }, [selectedNode, selectedIndex, nodes]);

  const moveUp = useCallback(() => {
    autoSelectRef.current = false;
    setSelectedId(prev => {
      const ns = nodesRef.current;
      const idx = ns.findIndex(n => n.id === prev);
      if (idx > 0) return ns[idx - 1]!.id;
      return prev;
    });
  }, []);

  const moveDown = useCallback(() => {
    autoSelectRef.current = false;
    setSelectedId(prev => {
      const ns = nodesRef.current;
      const idx = ns.findIndex(n => n.id === prev);
      if (idx < ns.length - 1) return ns[idx + 1]!.id;
      return prev;
    });
  }, []);

  const moveToTop = useCallback(() => {
    autoSelectRef.current = false;
    const ns = nodesRef.current;
    if (ns.length > 0) setSelectedId(ns[0]!.id);
  }, []);

  const moveToBottom = useCallback(() => {
    autoSelectRef.current = false;
    const ns = nodesRef.current;
    if (ns.length > 0) setSelectedId(ns[ns.length - 1]!.id);
  }, []);

  const toggleCollapse = useCallback(() => {
    setSelectedId(currentId => {
      const ns = nodesRef.current;
      const idx = ns.findIndex(n => n.id === currentId);
      const node = ns[idx];
      if (!node || node.type !== 'room') return currentId;
      const roomId = node.id === 'room:__unassigned__' ? '__unassigned__' : node.label;
      setCollapsedRooms(prev => {
        const next = new Set(prev);
        if (next.has(roomId)) next.delete(roomId); else next.add(roomId);
        return next;
      });
      return currentId;
    });
  }, []);

  return { nodes, selectedIndex, selectedNode, selectedAgentName, selectedRoomName, moveUp, moveDown, moveToTop, moveToBottom, toggleCollapse };
}
