import type { Agent, AgentRole, Room, Message } from '../shared/types.ts';
import { isPaneDead } from '../tmux/index.ts';

const STATE_DIR = '/tmp/cc-tmux/state';

// In-memory state
const agents = new Map<string, Agent>();
const rooms = new Map<string, Room>();
const inboxes = new Map<string, Message[]>(); // agent_name -> messages
let nextSequence = 1;

// --- Agent operations ---

export function getAgent(name: string): Agent | undefined {
  return agents.get(name);
}

export function getAllAgents(): Agent[] {
  return Array.from(agents.values());
}

export function addAgent(name: string, role: AgentRole, room: string, tmuxTarget: string): Agent {
  let agent = agents.get(name);
  if (agent) {
    // Existing agent joining another room
    if (!agent.rooms.includes(room)) {
      agent.rooms.push(room);
    }
  } else {
    agent = {
      agent_id: name,
      name,
      role,
      rooms: [room],
      tmux_target: tmuxTarget,
      joined_at: new Date().toISOString(),
    };
    agents.set(name, agent);
    inboxes.set(name, []);
  }

  // Ensure room exists and has this agent
  let r = rooms.get(room);
  if (!r) {
    r = { name: room, members: [], created_at: new Date().toISOString() };
    rooms.set(room, r);
  }
  if (!r.members.includes(name)) {
    r.members.push(name);
  }

  flushState();
  return agent;
}

export function removeAgent(name: string, room: string): boolean {
  const agent = agents.get(name);
  if (!agent) return false;

  // Remove from room
  const r = rooms.get(room);
  if (r) {
    r.members = r.members.filter(m => m !== name);
    if (r.members.length === 0) {
      rooms.delete(room);
    }
  }

  // Remove room from agent
  agent.rooms = agent.rooms.filter(rm => rm !== room);

  // Remove messages for that room from inbox
  const inbox = inboxes.get(name);
  if (inbox) {
    const filtered = inbox.filter(m => m.room !== room);
    inboxes.set(name, filtered);
  }

  // If agent has no rooms left, fully remove
  if (agent.rooms.length === 0) {
    agents.delete(name);
    inboxes.delete(name);
  }

  flushState();
  return true;
}

export function removeAgentFully(name: string): void {
  const agent = agents.get(name);
  if (!agent) return;

  for (const room of agent.rooms) {
    const r = rooms.get(room);
    if (r) {
      r.members = r.members.filter(m => m !== name);
      if (r.members.length === 0) rooms.delete(room);
    }
  }
  agents.delete(name);
  inboxes.delete(name);
}

// --- Room operations ---

export function getRoom(name: string): Room | undefined {
  return rooms.get(name);
}

export function getAllRooms(): Room[] {
  return Array.from(rooms.values());
}

export function getRoomMembers(room: string): Agent[] {
  const r = rooms.get(room);
  if (!r) return [];
  return r.members.map(name => agents.get(name)).filter((a): a is Agent => a !== undefined);
}

export function isNameTakenInRoom(name: string, room: string): boolean {
  const r = rooms.get(room);
  if (!r) return false;
  return r.members.includes(name);
}

// --- Message operations ---

export function addMessage(
  to: string,
  from: string,
  room: string,
  text: string,
  mode: 'push' | 'pull',
  targetName: string | null,
): Message {
  const msg: Message = {
    message_id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from,
    room,
    to: targetName,
    text,
    timestamp: new Date().toISOString(),
    sequence: nextSequence++,
    mode,
  };

  let inbox = inboxes.get(to);
  if (!inbox) {
    inbox = [];
    inboxes.set(to, inbox);
  }
  inbox.push(msg);

  flushState();
  return msg;
}

export function readMessages(
  agentName: string,
  room?: string,
  sinceSequence?: number,
): { messages: Message[]; next_sequence: number } {
  const inbox = inboxes.get(agentName) ?? [];
  let filtered = inbox;

  if (room) {
    filtered = filtered.filter(m => m.room === room);
  }
  if (sinceSequence !== undefined) {
    filtered = filtered.filter(m => m.sequence > sinceSequence);
  }

  const maxSeq = filtered.length > 0
    ? Math.max(...filtered.map(m => m.sequence))
    : sinceSequence ?? 0;

  return { messages: filtered, next_sequence: maxSeq };
}

export function getAllMessages(): Message[] {
  const all: Message[] = [];
  for (const msgs of inboxes.values()) {
    all.push(...msgs);
  }
  // Deduplicate by message_id (same message in multiple inboxes)
  const seen = new Set<string>();
  return all.filter(m => {
    if (seen.has(m.message_id)) return false;
    seen.add(m.message_id);
    return true;
  }).sort((a, b) => a.sequence - b.sequence);
}

// --- Persistence ---

async function ensureDir(): Promise<void> {
  const proc = Bun.spawn(['mkdir', '-p', STATE_DIR], { stdout: 'pipe', stderr: 'pipe' });
  await proc.exited;
}

function flushState(): void {
  // Fire-and-forget async write (NFR4: don't block tool calls)
  flushAsync().catch(() => {});
}

async function flushAsync(): Promise<void> {
  await ensureDir();

  const agentData: Record<string, Agent> = {};
  for (const [k, v] of agents) agentData[k] = v;

  const roomData: Record<string, Room> = {};
  for (const [k, v] of rooms) roomData[k] = v;

  const messageData: Message[] = getAllMessages();

  await Promise.all([
    Bun.write(`${STATE_DIR}/agents.json`, JSON.stringify(agentData, null, 2)),
    Bun.write(`${STATE_DIR}/rooms.json`, JSON.stringify(roomData, null, 2)),
    Bun.write(`${STATE_DIR}/messages.json`, JSON.stringify(messageData, null, 2)),
  ]);
}

export async function loadState(): Promise<void> {
  try {
    const agentsFile = Bun.file(`${STATE_DIR}/agents.json`);
    if (await agentsFile.exists()) {
      const data = JSON.parse(await agentsFile.text()) as Record<string, Agent>;
      for (const [k, v] of Object.entries(data)) agents.set(k, v);
    }

    const roomsFile = Bun.file(`${STATE_DIR}/rooms.json`);
    if (await roomsFile.exists()) {
      const data = JSON.parse(await roomsFile.text()) as Record<string, Room>;
      for (const [k, v] of Object.entries(data)) rooms.set(k, v);
    }

    const messagesFile = Bun.file(`${STATE_DIR}/messages.json`);
    if (await messagesFile.exists()) {
      const data = JSON.parse(await messagesFile.text()) as Message[];
      // Rebuild inboxes from messages
      let maxSeq = 0;
      for (const msg of data) {
        if (msg.to) {
          let inbox = inboxes.get(msg.to);
          if (!inbox) { inbox = []; inboxes.set(msg.to, inbox); }
          inbox.push(msg);
        }
        // Also store in "all agents in room" for broadcast tracking
        if (msg.sequence > maxSeq) maxSeq = msg.sequence;
      }
      nextSequence = maxSeq + 1;
    }
  } catch {
    // State files corrupted or missing — start fresh
  }
}

export async function validateLiveness(): Promise<string[]> {
  const deadAgents: string[] = [];
  for (const [name, agent] of agents) {
    const dead = await isPaneDead(agent.tmux_target);
    if (dead) {
      deadAgents.push(name);
      removeAgentFully(name);
    }
  }
  if (deadAgents.length > 0) {
    flushState();
  }
  return deadAgents;
}

export function clearState(): void {
  agents.clear();
  rooms.clear();
  inboxes.clear();
  nextSequence = 1;
}
