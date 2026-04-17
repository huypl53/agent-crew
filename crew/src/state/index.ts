import type { Agent, AgentRole, AgentTemplate, RoomTemplate, Room, Message, MessageKind, Task, TaskStatus, TaskEvent, TokenUsage, PricingEntry } from '../shared/types.ts';
import { isPaneDead, paneCommandLooksAlive } from '../tmux/index.ts';
import { getDb, initDb, closeDb, getDbPath } from './db.ts';

// Re-export for callers
export { initDb, closeDb };

// --- Helpers ---

function now(): string { return new Date().toISOString(); }

function dbAgentToAgent(row: Record<string, unknown>, agentRooms: string[]): Agent {
  return {
    agent_id: String(row.id),
    name: row.name as string,
    role: row.role as AgentRole,
    rooms: agentRooms,
    tmux_target: (row.pane as string | null) ?? null,
    agent_type: (row.agent_type as string ?? 'unknown') as 'claude-code' | 'codex' | 'unknown',
    joined_at: row.registered_at as string,
    last_activity: row.last_activity as string | undefined,
    persona: (row.persona as string | null) ?? undefined,
    capabilities: (row.capabilities as string | null) ?? undefined,
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
    reply_to: row.reply_to as number | null ?? null,
  };
}

// --- Agent operations ---

export function getAgentDbStatus(name: string): 'busy' | 'idle' | null {
  // Get status from most recent agent with this name
  const row = getDb().query('SELECT status FROM agents WHERE name = ? ORDER BY id DESC LIMIT 1').get(name) as { status: string | null } | null;
  const s = row?.status;
  return s === 'busy' || s === 'idle' ? s : null;
}

export function setAgentStatus(name: string, status: 'busy' | 'idle'): void {
  // Update status on most recent agent with this name
  const agent = getDb().query('SELECT id FROM agents WHERE name = ? ORDER BY id DESC LIMIT 1').get(name) as { id: number } | null;
  if (agent) {
    getDb().run('UPDATE agents SET status = ? WHERE id = ?', [status, agent.id]);
  }
}

/** Server-observed heartbeat: update last_activity when pane content changes. */
export function touchAgentActivity(name: string): void {
  getDb().run(
    'UPDATE agents SET last_activity = ? WHERE name = ? AND id = (SELECT id FROM agents WHERE name = ? ORDER BY id DESC LIMIT 1)',
    [new Date().toISOString(), name, name],
  );
}

export function getAgent(name: string): Agent | undefined {
  const db = getDb();
  // Return most recently registered agent with this name
  const row = db.query('SELECT * FROM agents WHERE name = ? ORDER BY id DESC LIMIT 1').get(name) as Record<string, unknown> | null;
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

export function addAgent(
  name: string,
  role: AgentRole,
  room: string,
  tmuxTarget: string | null,
  agentType: 'claude-code' | 'codex' | 'unknown' = 'unknown',
  persona?: string,
  capabilities?: string,
): Agent {
  const db = getDb();
  const ts = now();

  if (tmuxTarget) {
    // Check if pane is already taken by another agent
    const existingByPane = db.query('SELECT id, name FROM agents WHERE pane = ?').get(tmuxTarget) as { id: number; name: string } | null;
    if (existingByPane) {
      // Update existing row: change name and other fields
      db.run(
        `UPDATE agents SET name = ?, role = ?, agent_type = ?,
         persona = COALESCE(?, persona), capabilities = COALESCE(?, capabilities)
         WHERE id = ?`,
        [name, role, agentType, persona ?? null, capabilities ?? null, existingByPane.id],
      );
      // Update members if name changed
      if (existingByPane.name !== name) {
        db.run('UPDATE members SET agent = ? WHERE agent = ?', [name, existingByPane.name]);
        db.run('UPDATE cursors SET agent = ? WHERE agent = ?', [name, existingByPane.name]);
      }
    } else {
      // Check if there's an existing agent with this name — update their pane
      const existingByName = db.query('SELECT id FROM agents WHERE name = ? ORDER BY id DESC LIMIT 1').get(name) as { id: number } | null;
      if (existingByName) {
        // Update existing agent's pane and other fields
        db.run(
          `UPDATE agents SET pane = ?, role = ?, agent_type = ?,
           persona = COALESCE(?, persona), capabilities = COALESCE(?, capabilities)
           WHERE id = ?`,
          [tmuxTarget, role, agentType, persona ?? null, capabilities ?? null, existingByName.id],
        );
      } else {
        // Insert new agent row
        db.run(
          `INSERT INTO agents (name, role, pane, agent_type, registered_at, persona, capabilities) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [name, role, tmuxTarget, agentType, ts, persona ?? null, capabilities ?? null],
        );
      }
    }
  } else {
    // Pull-only agent (no pane) — check for existing agent with this name
    const existingByName = db.query('SELECT id FROM agents WHERE name = ? AND pane IS NULL ORDER BY id DESC LIMIT 1').get(name) as { id: number } | null;
    if (existingByName) {
      // Update existing pull-only agent
      db.run(
        `UPDATE agents SET role = ?, agent_type = ?,
         persona = COALESCE(?, persona), capabilities = COALESCE(?, capabilities)
         WHERE id = ?`,
        [role, agentType, persona ?? null, capabilities ?? null, existingByName.id],
      );
    } else {
      // Insert new pull-only agent row
      db.run(
        `INSERT INTO agents (name, role, pane, agent_type, registered_at, persona, capabilities) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [name, role, null, agentType, ts, persona ?? null, capabilities ?? null],
      );
    }
  }

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
  // Delete all agent rows with this name
  db.run('DELETE FROM agents WHERE name = ?', [name]);
  db.run('DELETE FROM cursors WHERE agent = ?', [name]);
}

/** Remove agent by database ID (for precise deletion) */
export function removeAgentById(id: number): void {
  const db = getDb();
  const agent = db.query('SELECT name FROM agents WHERE id = ?').get(id) as { name: string } | null;
  if (!agent) return;

  const name = agent.name;
  // Check if there are other agents with the same name
  const otherAgents = (db.query('SELECT COUNT(*) as c FROM agents WHERE name = ? AND id != ?').get(name, id) as { c: number }).c;

  if (otherAgents === 0) {
    // This is the only agent with this name — clean up memberships
    const agentRooms = (db.query('SELECT room FROM members WHERE agent = ?').all(name) as { room: string }[]).map(r => r.room);
    db.run('DELETE FROM members WHERE agent = ?', [name]);
    for (const room of agentRooms) {
      const count = (db.query('SELECT COUNT(*) as c FROM members WHERE room = ?').get(room) as { c: number }).c;
      if (count === 0) db.run('DELETE FROM rooms WHERE name = ?', [room]);
    }
    db.run('DELETE FROM cursors WHERE agent = ?', [name]);
  }

  // Delete the specific agent row
  db.run('DELETE FROM agents WHERE id = ?', [id]);
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

const IDLE_KINDS = new Set<MessageKind>(['completion', 'error', 'question', 'note']);

export function addMessage(
  _to: string,
  from: string,
  room: string,
  text: string,
  mode: 'push' | 'pull',
  targetName: string | null,
  kind: MessageKind = 'chat',
  replyTo?: number | null,
): Message {
  const db = getDb();
  const ts = now();

  const insert = db.transaction(() => {
    const stmt = db.run(
      'INSERT INTO messages (sender, room, recipient, text, kind, mode, timestamp, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [from, room, targetName, text, kind, mode, ts, replyTo ?? null],
    );

    // Event-driven status: update agent busy/idle atomically with the message write
    if (kind === 'task' && targetName) {
      db.run('UPDATE agents SET status = ? WHERE name = ?', ['busy', targetName]);
    } else if (IDLE_KINDS.has(kind)) {
      db.run('UPDATE agents SET status = ? WHERE name = ?', ['idle', from]);
    }

    return stmt.lastInsertRowid;
  });

  const rowid = insert();
  const row = db.query('SELECT * FROM messages WHERE id = ?').get(rowid) as Record<string, unknown>;
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

  // Fast path: agent exists in SQLite — update pane for the most recent agent with this name
  const existing = db.query('SELECT id FROM agents WHERE name = ? ORDER BY id DESC LIMIT 1').get(name) as { id: number } | null;
  if (existing) {
    // Check if newPane is already taken by another agent
    const paneOwner = db.query('SELECT id FROM agents WHERE pane = ?').get(newPane) as { id: number } | null;
    if (paneOwner && paneOwner.id !== existing.id) {
      // Evict the other agent from this pane
      db.run('UPDATE agents SET pane = NULL WHERE id = ?', [paneOwner.id]);
    }
    db.run('UPDATE agents SET pane = ? WHERE id = ?', [newPane, existing.id]);
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

  // Insert new agent row
  db.run(
    `INSERT INTO agents (name, role, pane, agent_type, registered_at) VALUES (?, ?, ?, 'unknown', ?)`,
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

/** Error-out tasks and remove an agent from the registry when its pane is stale. */
export function markAgentStale(agentName: string): void {
  cleanupDeadAgentTasks(agentName);
  removeAgentFully(agentName);
}

export async function validateLiveness(): Promise<string[]> {
  const dead: string[] = [];
  for (const agent of getAllAgents()) {
    if (!agent.tmux_target) continue; // pull-only agent: no pane to check
    if (await isPaneDead(agent.tmux_target)) {
      markAgentStale(agent.name);
      dead.push(agent.name);
      continue;
    }
    // For known agent types, also verify the pane is still running an agent process.
    // Skip 'unknown' agents (e.g. CLI-registered or test panes) to avoid false evictions.
    if (agent.agent_type === 'claude-code' || agent.agent_type === 'codex') {
      if (!await paneCommandLooksAlive(agent.tmux_target)) {
        markAgentStale(agent.name);
        dead.push(agent.name);
      }
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
  const taskId = stmt.lastInsertRowid as number;

  // Record initial task event
  recordTaskEvent(taskId, null, 'sent', createdBy);

  return getTask(taskId)!;
}

export function getTask(id: number): Task | undefined {
  const row = getDb().query('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | null;
  if (!row) return undefined;
  return rowToTask(row);
}

export function getTaskDetails(id: number): Task | undefined {
  return getTask(id);
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

export function updateTaskStatus(id: number, status: TaskStatus, note?: string, context?: string, triggeredBy?: string): Task | undefined {
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
  if (context !== undefined) {
    sql += ', context = ?';
    params.push(context);
  }
  sql += ' WHERE id = ?';
  params.push(id);
  db.run(sql, params);

  // Record the event
  recordTaskEvent(id, existing.status, status, triggeredBy ?? null);

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

/**
 * Cancel all queued/sent tasks for an agent. Used when clearing a worker's
 * session so their context wipe doesn't leave orphaned work in the queue.
 * Returns the number of tasks cancelled. Does not touch active/terminal tasks.
 */
export function cancelQueuedTasksForAgent(agentName: string, triggeredBy?: string): number {
  const db = getDb();
  const ts = now();
  const rows = db.query(
    `SELECT id, status FROM tasks WHERE assigned_to = ? AND status IN ('sent', 'queued')`,
  ).all(agentName) as Array<{ id: number; status: TaskStatus }>;
  if (rows.length === 0) return 0;
  db.run(
    `UPDATE tasks SET status = 'cancelled', note = 'worker session cleared', updated_at = ?
     WHERE assigned_to = ? AND status IN ('sent', 'queued')`,
    [ts, agentName],
  );
  for (const row of rows) {
    recordTaskEvent(row.id, row.status, 'cancelled', triggeredBy ?? null);
  }
  return rows.length;
}

export interface SearchTasksParams {
  keyword?: string;
  room?: string;
}

export interface SearchTaskResult {
  id: number;
  room: string;
  summary: string;
  status: TaskStatus;
  context_preview?: string;
}

export function searchTasks(params: SearchTasksParams): SearchTaskResult[] {
  const db = getDb();
  let sql = 'SELECT id, room, summary, status, context FROM tasks WHERE 1=1';
  const queryParams: unknown[] = [];

  if (params.room) {
    sql += ' AND room = ?';
    queryParams.push(params.room);
  }

  if (params.keyword) {
    sql += ' AND (summary LIKE ? OR context LIKE ?)';
    const searchTerm = `%${params.keyword}%`;
    queryParams.push(searchTerm, searchTerm);
  }

  sql += ' ORDER BY id';
  const rows = db.query(sql).all(...queryParams) as Array<Record<string, unknown>>;

  return rows.map(row => {
    const context = row.context as string | null;
    let preview: string | undefined;
    if (context) {
      preview = context.length > 200 ? context.slice(0, 200) + '...' : context;
    }
    return {
      id: row.id as number,
      room: row.room as string,
      summary: row.summary as string,
      status: row.status as TaskStatus,
      context_preview: preview,
    };
  });
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
    context: row.context as string | undefined,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

// --- Task event operations ---

export function recordTaskEvent(taskId: number, fromStatus: string | null, toStatus: string, triggeredBy: string | null): void {
  const db = getDb();
  const ts = now();
  db.run(
    'INSERT INTO task_events (task_id, from_status, to_status, triggered_by, timestamp) VALUES (?, ?, ?, ?, ?)',
    [taskId, fromStatus, toStatus, triggeredBy, ts],
  );
}

export function getTaskEvents(taskId: number): TaskEvent[] {
  const db = getDb();
  return (db.query('SELECT * FROM task_events WHERE task_id = ? ORDER BY timestamp').all(taskId) as TaskEvent[]);
}

export function getAllTaskEvents(): TaskEvent[] {
  const db = getDb();
  return (db.query('SELECT * FROM task_events ORDER BY timestamp').all() as TaskEvent[]);
}

// --- Token usage operations ---

export function recordTokenUsage(entry: Omit<TokenUsage, 'id' | 'recorded_at'>): void {
  const db = getDb();
  db.run(
    `INSERT INTO token_usage (agent_name, session_id, model, input_tokens, output_tokens, cost_usd, source, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(agent_name) DO UPDATE SET
       session_id=excluded.session_id,
       model=excluded.model,
       input_tokens=excluded.input_tokens,
       output_tokens=excluded.output_tokens,
       cost_usd=excluded.cost_usd,
       source=excluded.source,
       recorded_at=CURRENT_TIMESTAMP`,
    [entry.agent_name, entry.session_id ?? null, entry.model ?? null,
     entry.input_tokens, entry.output_tokens, entry.cost_usd ?? null, entry.source],
  );
}

export function getTokenUsageForAgent(agentName: string): TokenUsage[] {
  const db = getDb();
  return (db.query('SELECT * FROM token_usage WHERE agent_name = ? ORDER BY recorded_at DESC').all(agentName) as TokenUsage[]);
}

export function getLatestTokenUsage(agentName: string): TokenUsage | null {
  const db = getDb();
  return (db.query('SELECT * FROM token_usage WHERE agent_name = ? ORDER BY recorded_at DESC LIMIT 1').get(agentName) as TokenUsage) ?? null;
}

export function getAgentMessageCounts(name: string): { sent: number; received: number } {
  const db = getDb();
  const sent = (db.query('SELECT COUNT(*) as cnt FROM messages WHERE "from" = ?').get(name) as any)?.cnt ?? 0;
  const received = (db.query('SELECT COUNT(*) as cnt FROM messages WHERE "to" = ?').get(name) as any)?.cnt ?? 0;
  return { sent, received };
}

export function getAgentTaskStats(name: string): { done: number; active: number; queued: number; error: number } {
  const db = getDb();
  const rows = db.query('SELECT status, COUNT(*) as cnt FROM tasks WHERE assigned_to = ? GROUP BY status').all(name) as { status: string; cnt: number }[];
  const counts = { done: 0, active: 0, queued: 0, error: 0 };
  for (const row of rows) {
    if (row.status in counts) (counts as any)[row.status] = row.cnt;
  }
  return counts;
}

export function getTotalCost(): number {
  const db = getDb();
  const row = db.query('SELECT SUM(cost_usd) as total FROM token_usage').get() as any;
  return row?.total ?? 0;
}

export function getAgentCost(agentName: string): number {
  const db = getDb();
  const row = db.query('SELECT SUM(cost_usd) as total FROM token_usage WHERE agent_name = ?').get(agentName) as any;
  return row?.total ?? 0;
}

export function getPricing(): PricingEntry[] {
  const db = getDb();
  return (db.query('SELECT * FROM pricing ORDER BY model_name').all() as PricingEntry[]);
}

export function upsertPricing(modelName: string, inputCostPerMillion: number, outputCostPerMillion: number): void {
  const db = getDb();
  db.run(
    'INSERT INTO pricing (model_name, input_cost_per_million, output_cost_per_million) VALUES (?, ?, ?) ON CONFLICT(model_name) DO UPDATE SET input_cost_per_million = excluded.input_cost_per_million, output_cost_per_million = excluded.output_cost_per_million',
    [modelName, inputCostPerMillion, outputCostPerMillion],
  );
}

export function getPricingForModel(modelName: string): PricingEntry | null {
  const db = getDb();
  return (db.query('SELECT * FROM pricing WHERE model_name = ?').get(modelName) as PricingEntry) ?? null;
}

// --- Change detection ---

export function getChangeVersions(scopes: string[]): Record<string, { version: number; updated_at: string }> {
  const db = getDb();
  const result: Record<string, { version: number; updated_at: string }> = {};
  for (const scope of scopes) {
    const row = db.query('SELECT version, updated_at FROM change_log WHERE scope = ?').get(scope) as { version: number; updated_at: string } | null;
    if (row) result[scope] = row;
  }
  return result;
}

// --- Template reads ---

export function getAllTemplates(): AgentTemplate[] {
  return getDb().query('SELECT * FROM agent_templates ORDER BY id').all() as AgentTemplate[];
}

export function getRoomTemplateNames(room: string): string[] {
  return (getDb().query(
    'SELECT t.name FROM agent_templates t JOIN room_templates rt ON rt.template_id=t.id WHERE rt.room=? ORDER BY t.id'
  ).all(room) as { name: string }[]).map(r => r.name);
}

export function getAllRoomTemplates(): RoomTemplate[] {
  const rows = getDb().query('SELECT * FROM room_template_definitions ORDER BY id').all() as Array<{
    id: number; name: string; topic: string | null; agent_template_ids: string; created_at: string;
  }>;
  return rows.map(r => ({
    ...r,
    agent_template_ids: JSON.parse(r.agent_template_ids) as number[],
  }));
}

// --- Test helpers ---

export function clearState(): void {
  const db = getDb();
  db.exec('DELETE FROM token_usage; DELETE FROM pricing; DELETE FROM tasks; DELETE FROM messages; DELETE FROM cursors; DELETE FROM members; DELETE FROM rooms; DELETE FROM agents;');
}
