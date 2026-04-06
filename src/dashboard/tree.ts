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
}

export class TreeState {
  private nodes: TreeNode[] = [];
  private selectedIndex = -1;
  private autoSelect = true;
  private collapsedRooms = new Set<string>();
  private lastMostRecentAgent: string | null = null;

  get items(): TreeNode[] { return this.nodes; }
  get selected(): number { return this.selectedIndex; }
  get selectedNode(): TreeNode | null { return this.nodes[this.selectedIndex] ?? null; }
  get selectedAgentName(): string | null {
    const n = this.selectedNode;
    return n?.type === 'agent' ? (n.agentName ?? null) : null;
  }

  build(agents: Record<string, Agent>, rooms: Record<string, Room>, statuses: Map<string, AgentStatusEntry>): void {
    const nodes: TreeNode[] = [];
    const agentPrimary = new Map<string, string>();
    for (const [name, agent] of Object.entries(agents)) {
      if (agent.rooms.length > 0) agentPrimary.set(name, agent.rooms[0]!);
    }

    let mostRecent: string | null = null;
    let mostRecentTime = 0;
    for (const [name, entry] of statuses.entries()) {
      if (entry.lastChange > mostRecentTime) { mostRecentTime = entry.lastChange; mostRecent = name; }
    }

    for (const roomName of Object.keys(rooms).sort()) {
      const room = rooms[roomName]!;
      const membersInRoom = room.members.filter(m => agentPrimary.get(m) === roomName);

      nodes.push({ type: 'room', id: `room:${roomName}`, label: roomName, memberCount: membersInRoom.length, collapsed: this.collapsedRooms.has(roomName) });

      if (!this.collapsedRooms.has(roomName)) {
        for (const memberName of membersInRoom) {
          const agent = agents[memberName];
          if (!agent) continue;
          const extra = agent.rooms.filter(r => r !== roomName);
          nodes.push({
            type: 'agent', id: `agent:${memberName}`, label: memberName,
            agentName: memberName, role: agent.role,
            status: statuses.get(memberName)?.status ?? 'unknown',
            extraRooms: extra.length > 0 ? extra : undefined,
          });
        }
      }
    }

    this.nodes = nodes;

    if (this.autoSelect && mostRecent && mostRecent !== this.lastMostRecentAgent) {
      this.lastMostRecentAgent = mostRecent;
      const idx = nodes.findIndex(n => n.type === 'agent' && n.agentName === mostRecent);
      if (idx >= 0) this.selectedIndex = idx;
    }

    if (this.selectedIndex < 0 && nodes.length > 0) {
      const first = nodes.findIndex(n => n.type === 'agent');
      this.selectedIndex = first >= 0 ? first : 0;
    }
    if (this.selectedIndex >= nodes.length) this.selectedIndex = Math.max(0, nodes.length - 1);
  }

  moveUp(): void { this.autoSelect = false; if (this.selectedIndex > 0) this.selectedIndex--; }
  moveDown(): void { this.autoSelect = false; if (this.selectedIndex < this.nodes.length - 1) this.selectedIndex++; }
  moveToTop(): void { this.autoSelect = false; if (this.nodes.length > 0) this.selectedIndex = 0; }
  moveToBottom(): void { this.autoSelect = false; if (this.nodes.length > 0) this.selectedIndex = this.nodes.length - 1; }
  toggleCollapse(): void {
    const n = this.selectedNode;
    if (n?.type === 'room') {
      if (this.collapsedRooms.has(n.label)) this.collapsedRooms.delete(n.label);
      else this.collapsedRooms.add(n.label);
    }
  }
}
