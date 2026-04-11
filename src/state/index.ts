import type { Agent, AgentRole, Room, Message, MessageKind, Task, TaskStatus } from '../shared/types.ts';
import { isPaneDead } from '../tmux/index.ts';
import { getDb, initDb, closeDb, getDbPath } from './db.ts';

// Re-export for callers
export { initDb, closeDb };

// --- Helpers ---

function now(): string { return new Date().toISOString(); }

function dbAgentToAgent(row: Record<string, unknown>, agentRooms: string[]): Agent {
  return {
    agent_id: row.name as string,
    name: row.name as string,
    role: row.role as AgentRole,
    rooms: agentRooms,
    tmux_target: row.pane as string,
    joined_at: row.registered_at as string,
    last_activity: row.last_activity as string | undefined,
  };
}

function dbRoomToRoom(row: Record<string, unknown>, members: string[]): Room {
  return {
    name: row.name as string,
    members,
    topic: row.topic as string | undefined,
    created_at: row.created_at as string,
  };
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    message_id: String(row.id),
    from: row.sender as string,
    room: row.room as string,
    to: row.recipient as string | null,
    text: row.text as string,
    kind: row.kind as MessageKind,
    timestamp: row.timestamp as string,
    sequence: row.id as number,
    mode: row.mode as 'push' | 'pull',
  };
}

// --- Agent operations ---

export function getAgent(name: string): Agent | undefined {
  const db = getDb();
  const row = db.query('SELECT * FROM agents WHERE name = ?').get(name) as Record<string, unknown> | null;
  if (!row) return undefined;
  const agentRooms = (db.query('SELECT room FROM members WHERE agent = ? ORDER BY joined_at').all(name) as { room: string }[]).map(r => r.room);
  return dbAgentToAgent(row, agentRooms);
}

export function getAllAgents(): Agent[] {
  const db = getDb();
  const rows = db.query('SELECT * FROM agents').all() as Record<string, unknown>[];
  return rows.map(row => {
    const agentRooms = (db.query('SELECT room FROM members WHERE agent = ? ORDER BY joined_at').all(row.name) as { room: string }[]).map(r => r.room);
    return dbAgentToAgent(row, agentRooms);
  });
}

export function addAgent(name: string, role: AgentRole, room: string, tmuxTarget: string): Agent {
  const db = getDb();
  const ts = now();

  db.run(
    `INSERT INTO agents (name, role, pane, registered_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET pane = excluded.pane`,
    [name, role, tmuxTarget, ts],
  );

  db.run(
    'INSERT OR IGNORE INTO rooms (name, created_at) VALUES (?, ?)',
    [room, ts],
  );

  db.run(
    'INSERT OR IGNORE INTO members (room, agent, joined_at) VALUES (?, ?, ?)',
    [room, name, ts],
  );

  return getAgent(name)!;
}

export function removeAgent(name: string, room: string): boolean {
  const db = getDb();
  const changes = db.run('DELETE FROM members WHERE room = ? AND agent = ?', [room, name]).changes;
  if (changes === 0) return false;

  // Delete room if empty
  const count = (db.query('SELECT COUNT(*) as c FROM members WHERE room = ?').get(room) as { c: number }).c;
  if (count === 0) db.run('DELETE FROM rooms WHERE name = ?', [room]);

  // Delete agent if no rooms left
  const agentRooms = (db.query('SELECT COUNT(*) as c FROM members WHERE agent = ?').get(name) as { c: number }).c;
  if (agentRooms === 0) {
    db.run('DELETE FROM agents WHERE name = ?', [name]);
    db.run('DELETE FROM cursors WHERE agent = ?', [name]);
  }

  return true;
}

export function removeAgentFully(name: string): void {
  const db = getDb();
  // Delete memberships first, then clean up empty rooms
  const agentRooms = (db.query('SELECT room FROM members WHERE agent = ?').all(name) as { room: string }[]).map(r => r.room);
  db.run('DELETE FROM members WHERE agent = ?', [name]);
  for (const room of agentRooms) {
    const count = (db.query('SELECT COUNT(*) as c FROM members WHERE room = ?').get(room) as { c: number }).c;
    if (count === 0) db.run('DELETE FROM rooms WHERE name = ?', [room]);
  }
  db.run('DELETE FROM agents WHERE name = ?', [name]);
  db.run('DELETE FROM cursors WHERE agent = ?', [name]);
}

// --- Room operations ---

export function getRoom(name: string): Room | undefined {
  const db = getDb();
  const row = db.query('SELECT * FROM rooms WHERE name = ?').get(name) as Record<string, unknown> | null;
  if (!row) return undefined;
  const members = (db.query('SELECT agent FROM members WHERE room = ? ORDER BY joined_at').all(name) as { agent: string }[]).map(r => r.agent);
  return dbRoomToRoom(row, members);
}

export function getAllRooms(): Room[] {
  const db = getDb();
  const rows = db.query('SELECT * FROM rooms').all() as Record<string, unknown>[];
  return rows.map(row => {
    const members = (db.query('SELECT agent FROM members WHERE room = ? ORDER BY joined_at').all(row.name) as { agent: string }[]).map(r => r.agent);
    return dbRoomToRoom(row, members);
  });
}

export function getRoomMembers(room: string): Agent[] {
  const db = getDb();
  const rows = db.query(
    'SELECT a.* FROM agents a JOIN members m ON m.agent = a.name WHERE m.room = ? ORDER BY m.joined_at',
  ).all(room) as Record<string, unknown>[];
  return rows.map(row => {
    const agentRooms = (db.query('SELECT room FROM members WHERE agent = ? ORDER BY joined_at').all(row.name) as { room: string }[]).map(r => r.room);
    return dbAgentToAgent(row, agentRooms);
  });
}

export function setRoomTopic(roomName: string, topic: string): boolean {
  const changes = getDb().run('UPDATE rooms SET topic = ? WHERE name = ?', [topic, roomName]).changes;
  return changes > 0;
}

export function isNameTakenInRoom(name: string, room: string): boolean {
  const row = getDb().query('SELECT 1 FROM members WHERE room = ? AND agent = ?').get(room, name);
  return row !== null;
}

// --- Message operations ---

export function addMessage(
  _to: string,
  from: string,
  room: string,
  text: string,
  mode: 'push' | 'pull',
  targetName: string | null,
  kind: MessageKind = 'chat',
): Message {
  const db = getDb();
  const stmt = db.run(
    'INSERT INTO messages (sender, room, recipient, text, kind, mode, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [from, room, targetName, text, kind, mode, now()],
  );
  const row = db.query('SELECT * FROM messages WHERE id = ?').get(stmt.lastInsertRowid) as Record<string, unknown>;
  return rowToMessage(row);
}

export function getRoomMessages(room: string, sinceSequence?: number, limit?: number): Message[] {
  const db = getDb();
  let sql = 'SELECT * FROM messages WHERE room = ?';
  const params: unknown[] = [room];
  if (sinceSequence !== undefined) { sql += ' AND id > ?'; params.push(sinceSequence); }
  sql += ' ORDER BY id';
  if (limit) { sql += ' LIMIT ?'; params.push(limit); }
  return (db.query(sql).all(...params) as Record<string, unknown>[]).map(rowToMessage);
}

export function getCursor(agentName: string, room: string): number {
  const row = getDb().query('SELECT last_seq FROM cursors WHERE agent = ? AND room = ?').get(agentName, room) as { last_seq: number } | null;
  return row?.last_seq ?? 0;
}

export function advanceCursor(agentName: string, room: string, sequence: number): void {
  const current = getCursor(agentName, room);
  if (sequence > current) {
    getDb().run(
      'INSERT OR REPLACE INTO cursors (agent, room, last_seq) VALUES (?, ?, ?)',
      [agentName, room, sequence],
    );
  }
}

export function readRoomMessages(
  agentName: string,
  room: string,
  kinds?: string[],
  limit = 50,
): { messages: Message[]; next_sequence: number } {
  const db = getDb();
  const cursor = getCursor(agentName, room);
  let sql = 'SELECT * FROM messages WHERE room = ? AND id > ?';
  const params: unknown[] = [room, cursor];
  if (kinds && kinds.length > 0) {
    sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }
  sql += ' ORDER BY id';
  const allMsgs = (db.query(sql).all(...params) as Record<string, unknown>[]).map(rowToMessage);
  // Take last `limit` messages
  const msgs = allMsgs.length > limit ? allMsgs.slice(-limit) : allMsgs;
  const maxSeq = msgs.length > 0 ? msgs[msgs.length - 1]!.sequence : cursor;
  advanceCursor(agentName, room, maxSeq);
  return { messages: msgs, next_sequence: maxSeq };
}

export function readMessages(
  agentName: string,
  room?: string,
  sinceSequence?: number,
): { messages: Message[]; next_sequence: number } {
  const db = getDb();
  let sql = 'SELECT * FROM messages WHERE recipient = ?';
  const params: unknown[] = [agentName];
  if (room) { sql += ' AND room = ?'; params.push(room); }
  if (sinceSequence !== undefined) { sql += ' AND id > ?'; params.push(sinceSequence); }
  sql += ' ORDER BY id';
  const msgs = (db.query(sql).all(...params) as Record<string, unknown>[]).map(rowToMessage);
  const maxSeq = msgs.length > 0 ? msgs[msgs.length - 1]!.sequence : sinceSequence ?? 0;
  return { messages: msgs, next_sequence: maxSeq };
}

export function getAllMessages(): Message[] {
  return (getDb().query('SELECT * FROM messages ORDER BY id').all() as Record<string, unknown>[]).map(rowToMessage);
}

// --- Refresh / migration ---

export async function refreshAgent(name: string, newPane: string): Promise<Agent | undefined> {
  const db = getDb();

  // Fast path: agent exists in SQLite — update pane and return
  const existing = db.query('SELECT * FROM agents WHERE name = ?').get(name) as Record<string, unknown> | null;
  if (existing) {
    db.run('UPDATE agents SET pane = ? WHERE name = ?', [newPane, name]);
    return getAgent(name);
  }

  // Fallback: try agents.json from legacy JSON state
  const stateDir = process.env.CREW_STATE_DIR ?? '/tmp/crew/state';
  const agentsFile = Bun.file(`${stateDir}/agents.json`);
  if (!(await agentsFile.exists())) return undefined;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(await agentsFile.text());
  } catch {
    return undefined;
  }

  const legacy = data[name] as { role?: string; rooms?: string[]; joined_at?: string } | undefined;
  if (!legacy) return undefined;

  const role = legacy.role as string ?? 'worker';
  const rooms: string[] = Array.isArray(legacy.rooms) ? legacy.rooms : [];
  const ts = legacy.joined_at as string ?? new Date().toISOString();

  // Insert agent
  db.run(
    `INSERT INTO agents (name, role, pane, registered_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET pane = excluded.pane`,
    [name, role, newPane, ts],
  );

  // Insert rooms and memberships
  for (const room of rooms) {
    db.run('INSERT OR IGNORE INTO rooms (name, created_at) VALUES (?, ?)', [room, ts]);
    db.run('INSERT OR IGNORE INTO members (room, agent, joined_at) VALUES (?, ?, ?)', [room, name, ts]);
  }

  return getAgent(name);
}

// --- Liveness ---

export async function validateLiveness(): Promise<string[]> {
  const dead: string[] = [];
  for (const agent of getAllAgents()) {
    if (await isPaneDead(agent.tmux_target)) {
      cleanupDeadAgentTasks(agent.name);
      removeAgentFully(agent.name);
      dead.push(agent.name);
    }
  }
  return dead;
}

// --- Task operations ---

export function createTask(
  room: string,
  assignedTo: string,
  createdBy: string,
  messageId: number | null,
  summary: string,
): Task {
  const db = getDb();
  const ts = now();
  const truncated = summary.length > 200 ? summary.slice(0, 197) + '...' : summary;
  const stmt = db.run(
    'INSERT INTO tasks (room, assigned_to, created_by, message_id, summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [room, assignedTo, createdBy, messageId, truncated, 'sent', ts, ts],
  );
  return getTask(stmt.lastInsertRowid as number)!;
}

export function getTask(id: number): Task | undefined {
  const row = getDb().query('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | null;
  if (!row) return undefined;
  return rowToTask(row);
}

export function getTasksForAgent(agentName: string, statuses?: TaskStatus[]): Task[] {
  const db = getDb();
  let sql = 'SELECT * FROM tasks WHERE assigned_to = ?';
  const params: unknown[] = [agentName];
  if (statuses && statuses.length > 0) {
    sql += ` AND status IN (${statuses.map(() => '?').join(',')})`;
    params.push(...statuses);
  }
  sql += ' ORDER BY id';
  return (db.query(sql).all(...params) as Record<string, unknown>[]).map(rowToTask);
}

const VALID_TRANSITIONS: Record<string, TaskStatus[]> = {
  sent:        ['queued', 'active', 'error'],
  queued:      ['active', 'cancelled', 'error'],
  active:      ['completed', 'error', 'interrupted'],
  interrupted: ['active', 'error'],
};

export function updateTaskStatus(id: number, status: TaskStatus, note?: string): Task | undefined {
  const db = getDb();
  const existing = getTask(id);
  if (!existing) return undefined;

  // Validate transition
  const allowed = VALID_TRANSITIONS[existing.status];
  if (!allowed || !allowed.includes(status)) {
    throw new Error(`Invalid transition: ${existing.status} → ${status}`);
  }

  const ts = now();
  let sql = 'UPDATE tasks SET status = ?, updated_at = ?';
  const params: unknown[] = [status, ts];
  if (note !== undefined) {
    sql += ', note = ?';
    params.push(note);
  }
  sql += ' WHERE id = ?';
  params.push(id);
  db.run(sql, params);
  return getTask(id);
}

/** Bypass transition validation — force-transition all non-terminal tasks to error */
export function cleanupDeadAgentTasks(agentName: string): void {
  const db = getDb();
  const ts = now();
  db.run(
    `UPDATE tasks SET status = 'error', note = 'agent pane died', updated_at = ?
     WHERE assigned_to = ? AND status IN ('sent', 'queued', 'active', 'interrupted')`,
    [ts, agentName],
  );
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as number,
    room: row.room as string,
    assigned_to: row.assigned_to as string,
    created_by: row.created_by as string,
    message_id: row.message_id as number | null,
    summary: row.summary as string,
    status: row.status as TaskStatus,
    note: row.note as string | undefined,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

// --- Test helpers ---

export function clearState(): void {
  const db = getDb();
  db.exec('DELETE FROM tasks; DELETE FROM messages; DELETE FROM cursors; DELETE FROM members; DELETE FROM rooms; DELETE FROM agents;');
}
