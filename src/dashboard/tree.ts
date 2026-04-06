import type { Agent, Room, AgentStatus } from '../shared/types.ts';
import type { AgentStatusEntry } from './status.ts';

export interface TreeNode {
  type: 'room' | 'agent';
  id: string;
  label: string;
  memberCount?: number;
  collapsed?: boolean;
  agentName?: string;
  role?: string;
  status?: AgentStatus;
  extraRooms?: string[];
  secondary?: boolean;
}

export class TreeState {
  private nodes: TreeNode[] = [];
  private _selectedIndex = -1;
  private selectedId: string | null = null;
  private autoSelect = true;
  private collapsedRooms = new Set<string>();
  private lastMostRecentAgent: string | null = null;

  get items(): TreeNode[] { return this.nodes; }
  get selected(): number { return this._selectedIndex; }
  get selectedNode(): TreeNode | null { return this.nodes[this._selectedIndex] ?? null; }
  get selectedAgentName(): string | null {
    const n = this.selectedNode;
    return n?.type === 'agent' ? (n.agentName ?? null) : null;
  }
  get selectedRoomName(): string | null {
    const n = this.selectedNode;
    if (n?.type === 'room') return n.label;
    if (n?.type === 'agent') {
      for (let i = this._selectedIndex - 1; i >= 0; i--) {
        if (this.nodes[i]?.type === 'room') return this.nodes[i]!.label;
      }
    }
    return null;
  }

  build(agents: Record<string, Agent>, rooms: Record<string, Room>, statuses: Map<string, AgentStatusEntry>): void {
    const nodes: TreeNode[] = [];

    let mostRecent: string | null = null;
    let mostRecentTime = 0;
    for (const [name, entry] of statuses.entries()) {
      if (entry.lastChange > mostRecentTime) { mostRecentTime = entry.lastChange; mostRecent = name; }
    }

    for (const roomName of Object.keys(rooms).sort()) {
      const room = rooms[roomName]!;
      const membersInRoom = room.members;

      nodes.push({
        type: 'room', id: `room:${roomName}`, label: roomName,
        memberCount: membersInRoom.length,
        collapsed: this.collapsedRooms.has(roomName),
      });

      if (!this.collapsedRooms.has(roomName)) {
        for (const memberName of membersInRoom) {
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

    // Unassigned: agents with no rooms
    const unassigned = Object.values(agents).filter(a => !a.rooms || a.rooms.length === 0);
    if (unassigned.length > 0) {
      nodes.push({
        type: 'room', id: 'room:__unassigned__',
        label: '── Unassigned ──',
        memberCount: unassigned.length,
        collapsed: this.collapsedRooms.has('__unassigned__'),
      });
      if (!this.collapsedRooms.has('__unassigned__')) {
        for (const agent of unassigned) {
          nodes.push({
            type: 'agent', id: `agent:${agent.name}`,
            label: agent.name, agentName: agent.name,
            role: agent.role, status: statuses.get(agent.name)?.status ?? 'unknown',
          });
        }
      }
    }

    this.nodes = nodes;

    // Auto-select most recently active agent (only when not manually navigated)
    if (this.autoSelect && mostRecent && mostRecent !== this.lastMostRecentAgent) {
      this.lastMostRecentAgent = mostRecent;
      const idx = nodes.findIndex(n => n.type === 'agent' && n.agentName === mostRecent);
      if (idx >= 0) { this._selectedIndex = idx; this.selectedId = nodes[idx]!.id; }
    }

    // Restore selection by ID (survives reorders and insertions)
    if (this.selectedId) {
      const idx = nodes.findIndex(n => n.id === this.selectedId);
      if (idx >= 0) this._selectedIndex = idx;
    }

    // Fallback to first agent if no selection
    if (this._selectedIndex < 0 && nodes.length > 0) {
      const first = nodes.findIndex(n => n.type === 'agent');
      this._selectedIndex = first >= 0 ? first : 0;
      this.selectedId = nodes[this._selectedIndex]?.id ?? null;
    }
    if (this._selectedIndex >= nodes.length) {
      this._selectedIndex = Math.max(0, nodes.length - 1);
      this.selectedId = nodes[this._selectedIndex]?.id ?? null;
    }
  }

  moveUp(): void {
    this.autoSelect = false;
    if (this._selectedIndex > 0) {
      this._selectedIndex--;
      this.selectedId = this.nodes[this._selectedIndex]?.id ?? null;
    }
  }
  moveDown(): void {
    this.autoSelect = false;
    if (this._selectedIndex < this.nodes.length - 1) {
      this._selectedIndex++;
      this.selectedId = this.nodes[this._selectedIndex]?.id ?? null;
    }
  }
  moveToTop(): void {
    this.autoSelect = false;
    if (this.nodes.length > 0) {
      this._selectedIndex = 0;
      this.selectedId = this.nodes[0]?.id ?? null;
    }
  }
  moveToBottom(): void {
    this.autoSelect = false;
    if (this.nodes.length > 0) {
      this._selectedIndex = this.nodes.length - 1;
      this.selectedId = this.nodes[this._selectedIndex]?.id ?? null;
    }
  }
  toggleCollapse(): void {
    const n = this.selectedNode;
    if (n?.type === 'room') {
      const roomId = n.id === 'room:__unassigned__' ? '__unassigned__' : n.label;
      if (this.collapsedRooms.has(roomId)) this.collapsedRooms.delete(roomId);
      else this.collapsedRooms.add(roomId);
    }
  }
}
