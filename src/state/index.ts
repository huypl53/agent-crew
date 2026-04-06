import type { Agent, AgentRole, Room, Message, MessageKind } from '../shared/types.ts';
import { isPaneDead } from '../tmux/index.ts';

const STATE_DIR = '/tmp/cc-tmux/state';

// In-memory state
const agents = new Map<string, Agent>();
const rooms = new Map<string, Room>();
const inboxes = new Map<string, Message[]>(); // agent_name -> messages
const roomMessages = new Map<string, Message[]>(); // room -> messages (canonical store)
const cursors = new Map<string, Map<string, number>>(); // agent_name -> room -> last_read_sequence
const MAX_ROOM_MESSAGES = 1000;
let nextSequence = 1;
let diskSyncEnabled = true;

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

export function setRoomTopic(roomName: string, topic: string): boolean {
  const room = rooms.get(roomName);
  if (!room) return false;
  room.topic = topic;
  flushState();
  return true;
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
  kind: MessageKind = 'chat',
): Message {
  const msg: Message = {
    message_id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from,
    room,
    to: targetName,
    text,
    kind,
    timestamp: new Date().toISOString(),
    sequence: nextSequence++,
    mode,
  };

  // Write to room log (canonical store)
  let roomLog = roomMessages.get(room);
  if (!roomLog) { roomLog = []; roomMessages.set(room, roomLog); }
  roomLog.push(msg);
  if (roomLog.length > MAX_ROOM_MESSAGES) {
    roomLog.splice(0, roomLog.length - MAX_ROOM_MESSAGES);
  }

  // Keep inbox for backward compat (skip '__room__' broadcast sentinel)
  if (to !== '__room__') {
    let inbox = inboxes.get(to);
    if (!inbox) { inbox = []; inboxes.set(to, inbox); }
    inbox.push(msg);
  }

  flushState();
  return msg;
}

export function getRoomMessages(room: string, sinceSequence?: number, limit?: number): Message[] {
  const msgs = roomMessages.get(room) ?? [];
  let filtered = msgs;
  if (sinceSequence !== undefined) {
    filtered = filtered.filter(m => m.sequence > sinceSequence);
  }
  if (limit) {
    filtered = filtered.slice(-limit);
  }
  return filtered;
}

export function getCursor(agentName: string, room: string): number {
  return cursors.get(agentName)?.get(room) ?? 0;
}

export function advanceCursor(agentName: string, room: string, sequence: number): void {
  let agentCursors = cursors.get(agentName);
  if (!agentCursors) { agentCursors = new Map(); cursors.set(agentName, agentCursors); }
  const current = agentCursors.get(room) ?? 0;
  if (sequence > current) agentCursors.set(room, sequence);
}

export function readRoomMessages(
  agentName: string,
  room: string,
  kinds?: string[],
  limit: number = 50,
): { messages: Message[]; next_sequence: number } {
  const cursor = getCursor(agentName, room);
  let msgs = getRoomMessages(room, cursor);
  if (kinds && kinds.length > 0) {
    msgs = msgs.filter(m => kinds.includes(m.kind));
  }
  if (msgs.length > limit) msgs = msgs.slice(-limit);

  const maxSeq = msgs.length > 0 ? Math.max(...msgs.map(m => m.sequence)) : cursor;
  advanceCursor(agentName, room, maxSeq);

  return { messages: msgs, next_sequence: maxSeq };
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

export async function flushAsync(): Promise<void> {
  await ensureDir();

  // Read-merge-write: merge disk state with in-memory to support multi-process
  const mergedAgents: Record<string, Agent> = {};
  const mergedRooms: Record<string, Room> = {};

  // Read existing disk state first
  try {
    const agentsFile = Bun.file(`${STATE_DIR}/agents.json`);
    if (await agentsFile.exists()) {
      const diskAgents = JSON.parse(await agentsFile.text()) as Record<string, Agent>;
      for (const [k, v] of Object.entries(diskAgents)) mergedAgents[k] = v;
    }
  } catch { /* ignore corrupt file */ }

  try {
    const roomsFile = Bun.file(`${STATE_DIR}/rooms.json`);
    if (await roomsFile.exists()) {
      const diskRooms = JSON.parse(await roomsFile.text()) as Record<string, Room>;
      for (const [k, v] of Object.entries(diskRooms)) mergedRooms[k] = v;
    }
  } catch { /* ignore corrupt file */ }

  // Overlay in-memory state (authoritative for this process's agents)
  for (const [k, v] of agents) mergedAgents[k] = v;

  // Merge room membership: union of disk + in-memory members
  for (const [k, v] of rooms) {
    const existing = mergedRooms[k];
    if (existing) {
      const allMembers = new Set([...existing.members, ...v.members]);
      mergedRooms[k] = { ...v, members: Array.from(allMembers) };
    } else {
      mergedRooms[k] = v;
    }
  }

  // Remove agents that were fully removed by this process
  for (const name of Object.keys(mergedAgents)) {
    if (!agents.has(name)) {
      // Check if another process owns this agent (it has a different pane)
      // Only remove if this process explicitly deleted it (via removeAgentFully)
      // We track this by checking if the agent was ever in our memory
      // Simple heuristic: keep agents we don't know about (from other processes)
    }
  }

  // Merge messages: union by message_id
  const mergedMessages: Message[] = [];
  const seenIds = new Set<string>();

  try {
    const msgFile = Bun.file(`${STATE_DIR}/messages.json`);
    if (await msgFile.exists()) {
      const diskMsgs = JSON.parse(await msgFile.text()) as Message[];
      for (const m of diskMsgs) {
        if (!seenIds.has(m.message_id)) {
          seenIds.add(m.message_id);
          mergedMessages.push(m);
        }
      }
    }
  } catch { /* ignore */ }

  for (const m of getAllMessages()) {
    if (!seenIds.has(m.message_id)) {
      seenIds.add(m.message_id);
      mergedMessages.push(m);
    }
  }

  mergedMessages.sort((a, b) => a.sequence - b.sequence);

  // Serialize room messages
  const roomMsgData: Record<string, Message[]> = {};
  for (const [k, v] of roomMessages) roomMsgData[k] = v;

  await Promise.all([
    Bun.write(`${STATE_DIR}/agents.json`, JSON.stringify(mergedAgents, null, 2)),
    Bun.write(`${STATE_DIR}/rooms.json`, JSON.stringify(mergedRooms, null, 2)),
    Bun.write(`${STATE_DIR}/messages.json`, JSON.stringify(mergedMessages, null, 2)),
    Bun.write(`${STATE_DIR}/room-messages.json`, JSON.stringify(roomMsgData, null, 2)),
  ]);
}

export async function loadState(): Promise<void> {
  diskSyncEnabled = true;
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
        if (msg.sequence > maxSeq) maxSeq = msg.sequence;
      }
      nextSequence = maxSeq + 1;
    }

    const roomMsgFile = Bun.file(`${STATE_DIR}/room-messages.json`);
    if (await roomMsgFile.exists()) {
      const data = JSON.parse(await roomMsgFile.text()) as Record<string, Message[]>;
      for (const [k, v] of Object.entries(data)) roomMessages.set(k, v);
    }
  } catch {
    // State files corrupted or missing — start fresh
  }
}

// Re-sync in-memory state from disk (pick up other processes' changes)
export async function syncFromDisk(): Promise<void> {
  if (!diskSyncEnabled) return;
  try {
    const agentsFile = Bun.file(`${STATE_DIR}/agents.json`);
    if (await agentsFile.exists()) {
      const data = JSON.parse(await agentsFile.text()) as Record<string, Agent>;
      for (const [k, v] of Object.entries(data)) {
        if (!agents.has(k)) agents.set(k, v);
      }
    }

    const roomsFile = Bun.file(`${STATE_DIR}/rooms.json`);
    if (await roomsFile.exists()) {
      const data = JSON.parse(await roomsFile.text()) as Record<string, Room>;
      for (const [k, v] of Object.entries(data)) {
        const existing = rooms.get(k);
        if (existing) {
          // Merge members
          const allMembers = new Set([...existing.members, ...v.members]);
          existing.members = Array.from(allMembers);
        } else {
          rooms.set(k, v);
        }
      }
    }

    const messagesFile = Bun.file(`${STATE_DIR}/messages.json`);
    if (await messagesFile.exists()) {
      const data = JSON.parse(await messagesFile.text()) as Message[];
      const existingIds = new Set<string>();
      for (const msgs of inboxes.values()) {
        for (const m of msgs) existingIds.add(m.message_id);
      }
      let maxSeq = nextSequence;
      for (const msg of data) {
        if (!existingIds.has(msg.message_id) && msg.to) {
          let inbox = inboxes.get(msg.to);
          if (!inbox) { inbox = []; inboxes.set(msg.to, inbox); }
          inbox.push(msg);
        }
        if (msg.sequence >= maxSeq) maxSeq = msg.sequence + 1;
      }
      nextSequence = maxSeq;
    }

    const roomMsgFile = Bun.file(`${STATE_DIR}/room-messages.json`);
    if (await roomMsgFile.exists()) {
      const data = JSON.parse(await roomMsgFile.text()) as Record<string, Message[]>;
      for (const [k, v] of Object.entries(data)) {
        const existing = roomMessages.get(k);
        if (existing) {
          const seenIds = new Set(existing.map(m => m.message_id));
          for (const m of v) {
            if (!seenIds.has(m.message_id)) existing.push(m);
          }
          existing.sort((a, b) => a.sequence - b.sequence);
          if (existing.length > MAX_ROOM_MESSAGES) existing.splice(0, existing.length - MAX_ROOM_MESSAGES);
        } else {
          roomMessages.set(k, v);
        }
      }
    }
  } catch { /* disk read failed — use stale in-memory */ }
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
  roomMessages.clear();
  cursors.clear();
  nextSequence = 1;
  diskSyncEnabled = false; // Disable sync after clear (re-enabled on loadState)
  // Also clean disk state to prevent syncFromDisk from loading stale data
  try {
    const fs = require('node:fs');
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
}
