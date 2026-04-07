import { useState, useCallback, useMemo } from 'react';
import type { Agent, Room, AgentStatus } from '../../shared/types.ts';
import type { AgentStatusEntry } from './useStatus.ts';

export interface TreeNode {
  type: 'room' | 'agent';
  id: string;
  label: string;
  memberCount?: number;
  collapsed?: boolean;
  agentName?: string;
  role?: string;
  status?: AgentStatus;
  secondary?: boolean;
}

/** Pure function: builds the flat node list from agents/rooms/statuses. Exported for testing. */
export function buildTree(
  agents: Record<string, Agent>,
  rooms: Record<string, Room>,
  statuses: Map<string, AgentStatusEntry>,
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
          status: statuses.get(memberName)?.status ?? 'unknown',
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
          role: agent.role, status: statuses.get(agent.name)?.status ?? 'unknown',
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
  const [autoSelect, setAutoSelect] = useState(true);
  const [lastMostRecentAgent, setLastMostRecentAgent] = useState<string | null>(null);

  const nodes = useMemo(() => buildTree(agents, rooms, statuses, collapsedRooms), [agents, rooms, statuses, collapsedRooms]);

  // Find most recently changed agent
  let mostRecent: string | null = null;
  let mostRecentTime = 0;
  for (const [name, entry] of statuses.entries()) {
    if (entry.lastChange > mostRecentTime) { mostRecentTime = entry.lastChange; mostRecent = name; }
  }

  // Resolve selected index from selectedId
  let selectedIndex = -1;

  // Auto-select most recently active agent
  if (autoSelect && mostRecent && mostRecent !== lastMostRecentAgent) {
    setLastMostRecentAgent(mostRecent);
    const idx = nodes.findIndex(n => n.type === 'agent' && n.agentName === mostRecent);
    if (idx >= 0) {
      selectedIndex = idx;
      setSelectedId(nodes[idx]!.id);
    }
  }

  // Restore by ID
  if (selectedId) {
    const idx = nodes.findIndex(n => n.id === selectedId);
    if (idx >= 0) selectedIndex = idx;
  }

  // Fallback
  if (selectedIndex < 0 && nodes.length > 0) {
    const first = nodes.findIndex(n => n.type === 'agent');
    selectedIndex = first >= 0 ? first : 0;
    if (!selectedId) setSelectedId(nodes[selectedIndex]?.id ?? null);
  }
  if (selectedIndex >= nodes.length) selectedIndex = Math.max(0, nodes.length - 1);

  const selectedNode = nodes[selectedIndex] ?? null;
  const selectedAgentName = selectedNode?.type === 'agent' ? (selectedNode.agentName ?? null) : null;

  let selectedRoomName: string | null = null;
  if (selectedNode?.type === 'room') {
    selectedRoomName = selectedNode.label;
  } else if (selectedNode?.type === 'agent') {
    for (let i = selectedIndex - 1; i >= 0; i--) {
      if (nodes[i]?.type === 'room') { selectedRoomName = nodes[i]!.label; break; }
    }
  }

  const moveUp = useCallback(() => {
    setAutoSelect(false);
    setSelectedId(prev => {
      const idx = nodes.findIndex(n => n.id === prev);
      if (idx > 0) return nodes[idx - 1]!.id;
      return prev;
    });
  }, [nodes]);

  const moveDown = useCallback(() => {
    setAutoSelect(false);
    setSelectedId(prev => {
      const idx = nodes.findIndex(n => n.id === prev);
      if (idx < nodes.length - 1) return nodes[idx + 1]!.id;
      return prev;
    });
  }, [nodes]);

  const moveToTop = useCallback(() => {
    setAutoSelect(false);
    if (nodes.length > 0) setSelectedId(nodes[0]!.id);
  }, [nodes]);

  const moveToBottom = useCallback(() => {
    setAutoSelect(false);
    if (nodes.length > 0) setSelectedId(nodes[nodes.length - 1]!.id);
  }, [nodes]);

  const toggleCollapse = useCallback(() => {
    if (!selectedNode || selectedNode.type !== 'room') return;
    const roomId = selectedNode.id === 'room:__unassigned__' ? '__unassigned__' : selectedNode.label;
    setCollapsedRooms(prev => {
      const next = new Set(prev);
      if (next.has(roomId)) next.delete(roomId); else next.add(roomId);
      return next;
    });
  }, [selectedNode]);

  return { nodes, selectedIndex, selectedNode, selectedAgentName, selectedRoomName, moveUp, moveDown, moveToTop, moveToBottom, toggleCollapse };
}
