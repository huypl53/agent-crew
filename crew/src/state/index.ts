import { config } from '../config.ts';
import type {
  Agent,
  AgentRole,
  AgentTemplate,
  HookEvent,
  InputBlockMode,
  Message,
  MessageDeliveryMetadata,
  PartyResponse,
  PartyState,
  PricingEntry,
  ReminderPolicy,
  Room,
  RoomTemplate,
  SweepBusyMode,
  SweepControlState,
  TokenUsage,
} from '../shared/types.ts';
import { isPaneDead, paneCommandLooksAlive } from '../tmux/index.ts';
import { renderBatchFinalMessage } from './batch-render.ts';
import {
  areAllBatchWorkersTerminal,
  completeBatchWorker,
  createMessageBatch,
  getBatchWorkers,
  getLatestBatchAssociationForWorker,
  getLatestBatchForWorker,
  getMessageBatch,
  getOpenBatchForWorker,
  getRenderableBatchWorkers,
  listHintableBatches,
  listIncompleteBatches,
  markBatchCompleted,
  markBatchHintSent,
  markBatchWorkerDispatchFailed,
  markBatchWorkerSent,
  recordBatchWorkerTerminalMessage,
  renderBatchPendingHint,
} from './batch-state.ts';
import { closeDb, getDb, initDb } from './db.ts';
import {
  armLeaderGoalReminder,
  canonicalizeGoalIdentity,
  completeGoal,
  consumeLeaderGoalReminder,
  getGoal,
  getGoalByAgent,
  getGoalById,
  getGoalHistory,
  getRoomGoalOverview,
  setGoal,
  tickGoalTurnCount,
  unsetGoal,
  updateGoalDescription,
} from './goal-state.ts';
import {
  createLeaderDialog,
  getActiveDialogForWorker,
  getDialogById,
  listPendingDialogs,
  markDialogAnswered,
} from './dialog-state.ts';

export type { GoalRecord } from './goal-state.ts';
// Re-export for callers
export {
  areAllBatchWorkersTerminal,
  armLeaderGoalReminder,
  canonicalizeGoalIdentity,
  closeDb,
  completeBatchWorker,
  completeGoal,
  consumeLeaderGoalReminder,
  createLeaderDialog,
  createMessageBatch,
  getActiveDialogForWorker,
  getBatchWorkers,
  getDialogById,
  getGoal,
  getGoalByAgent,
  getGoalById,
  getGoalHistory,
  getLatestBatchAssociationForWorker,
  getRoomGoalOverview,
  getLatestBatchForWorker,
  getMessageBatch,
  getOpenBatchForWorker,
  getRenderableBatchWorkers,
  initDb,
  listHintableBatches,
  listIncompleteBatches,
  listPendingDialogs,
  markBatchCompleted,
  markBatchHintSent,
  markBatchWorkerDispatchFailed,
  markBatchWorkerSent,
  markDialogAnswered,
  recordBatchWorkerTerminalMessage,
  renderBatchPendingHint,
  setGoal,
  tickGoalTurnCount,
  unsetGoal,
  updateGoalDescription,
};

// --- Helpers ---

function now(): string {
  return new Date().toISOString();
}

function parseReminderPolicy(raw: unknown): ReminderPolicy | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const data = JSON.parse(raw) as Partial<ReminderPolicy>;
    const cadenceMode = data.cadence_mode === 'every_n' ? 'every_n' : 'always';
    const cadenceN =
      typeof data.cadence_n === 'number' && Number.isFinite(data.cadence_n)
        ? Math.max(1, Math.floor(data.cadence_n))
        : 1;
    return {
      enabled: Boolean(data.enabled),
      prefix: typeof data.prefix === 'string' ? data.prefix : '',
      suffix: typeof data.suffix === 'string' ? data.suffix : '',
      cadence_mode: cadenceMode,
      cadence_n: cadenceN,
    };
  } catch {
    return null;
  }
}

function dbRowToAgent(row: Record<string, unknown>): Agent {
  return {
    agent_id: row.id as number,
    room_id: row.room_id as number,
    room_path: row.room_path as string,
    room_name: row.room_name as string,
    name: row.name as string,
    role: row.role as AgentRole,
    tmux_target: (row.pane as string | null) ?? null,
    agent_type: ((row.agent_type as string) ?? 'unknown') as
      | 'claude-code'
      | 'codex'
      | 'unknown',
    status: (row.status as string | null) ?? null,
    input_block_mode: ((row.input_block_mode as string) ??
      'off') as InputBlockMode,
    persona: (row.persona as string | null) ?? null,
    capabilities: (row.capabilities as string | null) ?? null,
    reminder_policy: parseReminderPolicy(row.reminder_policy),
  };
}

function dbRoomToRoom(row: Record<string, unknown>): Room {
  return {
    id: row.id as number,
    path: row.path as string,
    name: row.name as string,
    topic: (row.topic as string | null) ?? null,
    created_at: row.created_at as string,
    reminder_policy: parseReminderPolicy(row.reminder_policy),
  };
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    message_id: String(row.id),
    from: row.sender as string,
    room_id: row.room_id as number,
    to: row.recipient as string | null,
    text: row.text as string,
    timestamp: row.timestamp as string,
    sequence: row.id as number,
    reply_to: (row.reply_to as number | null) ?? null,
    batch_id: (row.batch_id as string | null) ?? null,
    worker_name: (row.worker_name as string | null) ?? null,
    prompt_file: (row.prompt_file as string | null) ?? null,
    manifest_order: (row.manifest_order as number | null) ?? null,
  };
}

// --- Agent operations ---

export function getAgentDbStatus(name: string): 'busy' | 'idle' | null {
  // Get status from most recent agent with this name
  const row = getDb()
    .query('SELECT status FROM agents WHERE name = ? ORDER BY id DESC LIMIT 1')
    .get(name) as { status: string | null } | null;
  const s = row?.status;
  return s === 'busy' || s === 'idle' ? s : null;
}

export function setAgentIdleMuted(name: string, muted: boolean): void {
  const agent = getDb()
    .query('SELECT id FROM agents WHERE name = ? ORDER BY id DESC LIMIT 1')
    .get(name) as { id: number } | null;
  if (agent) {
    getDb().run('UPDATE agents SET idle_muted = ? WHERE id = ?', [
      muted ? 1 : 0,
      agent.id,
    ]);
  }
}

export function isAgentIdleMuted(name: string): boolean {
  const row = getDb()
    .query(
      'SELECT idle_muted FROM agents WHERE name = ? ORDER BY id DESC LIMIT 1',
    )
    .get(name) as { idle_muted: number } | null;
  return row?.idle_muted === 1;
}

export function setAgentAutoSelfOnIdle(name: string, enabled: boolean): void {
  const agent = getDb()
    .query('SELECT id FROM agents WHERE name = ? ORDER BY id DESC LIMIT 1')
    .get(name) as { id: number } | null;
  if (agent) {
    getDb().run('UPDATE agents SET auto_self_on_idle = ? WHERE id = ?', [
      enabled ? 1 : 0,
      agent.id,
    ]);
  }
}

export function isAgentAutoSelfOnIdle(name: string): boolean {
  const row = getDb()
    .query(
      'SELECT auto_self_on_idle FROM agents WHERE name = ? ORDER BY id DESC LIMIT 1',
    )
    .get(name) as { auto_self_on_idle: number } | null;
  return row?.auto_self_on_idle !== 0; // default is on
}

export function setAgentStatus(name: string, status: 'busy' | 'idle'): void {
  // Update status on most recent agent with this name
  const agent = getDb()
    .query('SELECT id FROM agents WHERE name = ? ORDER BY id DESC LIMIT 1')
    .get(name) as { id: number } | null;
  if (agent) {
    getDb().run('UPDATE agents SET status = ? WHERE id = ?', [
      status,
      agent.id,
    ]);
  }
}

export function getAgentInputBlockMode(name: string): InputBlockMode {
  const row = getDb()
    .query(
      'SELECT input_block_mode FROM agents WHERE name = ? ORDER BY id DESC LIMIT 1',
    )
    .get(name) as { input_block_mode: string | null } | null;
  const mode = row?.input_block_mode;
  return mode === 'armed' || mode === 'persist' ? mode : 'off';
}

export function setAgentInputBlockMode(
  name: string,
  mode: InputBlockMode,
): InputBlockMode {
  const agent = getDb()
    .query('SELECT id FROM agents WHERE name = ? ORDER BY id DESC LIMIT 1')
    .get(name) as { id: number } | null;
  if (agent) {
    getDb().run('UPDATE agents SET input_block_mode = ? WHERE id = ?', [
      mode,
      agent.id,
    ]);
  }
  return mode;
}

export function clearArmedInputBlock(name: string): boolean {
  const result = getDb().run(
    "UPDATE agents SET input_block_mode = 'off' WHERE name = ? AND id = (SELECT id FROM agents WHERE name = ? ORDER BY id DESC LIMIT 1) AND input_block_mode = 'armed'",
    [name, name],
  );
  return result.changes > 0;
}

export function getSweepControlState(): SweepControlState {
  const row = getDb()
    .query(
      `SELECT delivery_paused, pause_reason, busy_mode, updated_at
       FROM sweep_control WHERE id = 1`,
    )
    .get() as {
    delivery_paused: number;
    pause_reason: string | null;
    busy_mode: SweepBusyMode;
    updated_at: string;
  } | null;

  if (!row) {
    const nowTs = now();
    getDb().run(
      `INSERT INTO sweep_control (id, delivery_paused, pause_reason, busy_mode, updated_at)
       VALUES (1, 0, NULL, 'auto', ?)`,
      [nowTs],
    );
    return {
      delivery_paused: false,
      pause_reason: null,
      busy_mode: 'auto',
      updated_at: nowTs,
    };
  }

  return {
    delivery_paused: row.delivery_paused === 1,
    pause_reason: row.pause_reason,
    busy_mode:
      row.busy_mode === 'manual_busy' || row.busy_mode === 'manual_free'
        ? row.busy_mode
        : 'auto',
    updated_at: row.updated_at,
  };
}

export function setSweepPaused(
  paused: boolean,
  reason?: string,
): SweepControlState {
  const current = getSweepControlState();
  const nextReason = paused ? (reason?.trim() ? reason.trim() : null) : null;
  const ts = now();
  getDb().run(
    `UPDATE sweep_control
     SET delivery_paused = ?, pause_reason = ?, updated_at = ?
     WHERE id = 1`,
    [paused ? 1 : 0, nextReason, ts],
  );
  return {
    delivery_paused: paused,
    pause_reason: nextReason,
    busy_mode: current.busy_mode,
    updated_at: ts,
  };
}

export function setSweepBusyMode(mode: SweepBusyMode): SweepControlState {
  if (mode !== 'auto' && mode !== 'manual_busy' && mode !== 'manual_free') {
    throw new Error(`Invalid busy mode: ${mode}`);
  }
  const current = getSweepControlState();
  const ts = now();
  getDb().run(
    `UPDATE sweep_control
     SET busy_mode = ?, updated_at = ?
     WHERE id = 1`,
    [mode, ts],
  );
  return {
    delivery_paused: current.delivery_paused,
    pause_reason: current.pause_reason,
    busy_mode: mode,
    updated_at: ts,
  };
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
  const row = db
    .query(`
    SELECT a.*, r.path as room_path, r.name as room_name
    FROM agents a
    JOIN rooms r ON r.id = a.room_id
    WHERE a.name = ?
    ORDER BY a.id DESC
    LIMIT 1
  `)
    .get(name) as Record<string, unknown> | null;
  if (!row) return undefined;
  return dbRowToAgent(row);
}

export function getAllAgents(): Agent[] {
  const db = getDb();
  const rows = db
    .query(`
    SELECT a.*, r.path as room_path, r.name as room_name
    FROM agents a
    JOIN rooms r ON r.id = a.room_id
    ORDER BY a.id
  `)
    .all() as Record<string, unknown>[];
  return rows.map(dbRowToAgent);
}

export function addAgent(
  name: string,
  role: AgentRole,
  roomId: number,
  tmuxTarget: string | null,
  agentType: 'claude-code' | 'codex' | 'unknown' = 'unknown',
  persona?: string,
  capabilities?: string,
): Agent {
  const db = getDb();
  const ts = now();

  const existing = db
    .query('SELECT id FROM agents WHERE room_id = ? AND name = ?')
    .get(roomId, name) as { id: number } | null;

  if (existing) {
    if (tmuxTarget) {
      db.run('UPDATE agents SET pane = NULL WHERE pane = ? AND id != ?', [
        tmuxTarget,
        existing.id,
      ]);
    }
    db.run(
      `UPDATE agents SET role = ?, pane = ?, agent_type = ?, last_activity = ?,
       persona = COALESCE(?, persona), capabilities = COALESCE(?, capabilities)
       WHERE id = ?`,
      [
        role,
        tmuxTarget,
        agentType,
        ts,
        persona ?? null,
        capabilities ?? null,
        existing.id,
      ],
    );
  } else {
    if (tmuxTarget) {
      db.run('UPDATE agents SET pane = NULL WHERE pane = ?', [tmuxTarget]);
    }
    db.run(
      `INSERT INTO agents (room_id, name, role, pane, agent_type, registered_at, last_activity, persona, capabilities)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        roomId,
        name,
        role,
        tmuxTarget,
        agentType,
        ts,
        ts,
        persona ?? null,
        capabilities ?? null,
      ],
    );
  }

  return getAgentByRoomAndName(roomId, name)!;
}

export function removeAgent(name: string, room: string): boolean {
  const db = getDb();
  const roomObj = getRoom(room);
  if (!roomObj) return false;

  const hintChanges = db.run(
    'DELETE FROM agent_hints WHERE agent_name = ? AND room_id = ?',
    [name, roomObj.id],
  ).changes;
  const changes = db.run('DELETE FROM agents WHERE room_id = ? AND name = ?', [
    roomObj.id,
    name,
  ]).changes;
  if (changes === 0) return false;

  if (hintChanges > 0) bumpChangeLog('hints');

  const count = (
    db
      .query('SELECT COUNT(*) as c FROM agents WHERE room_id = ?')
      .get(roomObj.id) as { c: number }
  ).c;
  if (count === 0) db.run('DELETE FROM rooms WHERE id = ?', [roomObj.id]);

  return true;
}

export function removeAgentFully(name: string): void {
  const db = getDb();
  // Clear pane snapshot before deleting agent record
  const agentRow = db
    .query('SELECT pane FROM agents WHERE name = ? LIMIT 1')
    .get(name) as { pane: string | null } | undefined;
  if (agentRow?.pane) {
    import('../shared/pane-status.ts').then(({ clearPaneSnapshot }) =>
      clearPaneSnapshot(agentRow.pane!),
    );
  }
  const roomIds = (
    db
      .query('SELECT DISTINCT room_id FROM agents WHERE name = ?')
      .all(name) as { room_id: number }[]
  ).map((r) => r.room_id);
  const hintChanges = db.run('DELETE FROM agent_hints WHERE agent_name = ?', [
    name,
  ]).changes;
  db.run('DELETE FROM agents WHERE name = ?', [name]);
  if (hintChanges > 0) bumpChangeLog('hints');
  for (const roomId of roomIds) {
    const agentCount = (
      db
        .query('SELECT COUNT(*) as c FROM agents WHERE room_id = ?')
        .get(roomId) as { c: number }
    ).c;
    if (agentCount === 0) {
      db.run('DELETE FROM rooms WHERE id = ?', [roomId]);
    }
  }
}

/** Remove agent by database ID (for precise deletion) */
export function removeAgentById(id: number): void {
  const db = getDb();
  const row = db
    .query('SELECT room_id, name FROM agents WHERE id = ?')
    .get(id) as {
    room_id: number;
    name: string;
  } | null;
  if (!row) return;

  const hintChanges = db.run(
    'DELETE FROM agent_hints WHERE agent_name = ? AND room_id = ?',
    [row.name, row.room_id],
  ).changes;
  db.run('DELETE FROM agents WHERE id = ?', [id]);
  if (hintChanges > 0) bumpChangeLog('hints');

  const count = (
    db
      .query('SELECT COUNT(*) as c FROM agents WHERE room_id = ?')
      .get(row.room_id) as { c: number }
  ).c;
  if (count === 0) db.run('DELETE FROM rooms WHERE id = ?', [row.room_id]);
}

// --- Room operations ---

export function getRoom(identifier: string | number): Room | undefined {
  const db = getDb();
  let row: Record<string, unknown> | null;

  const parsedId =
    typeof identifier === 'number' ? identifier : Number(identifier);
  if (!Number.isNaN(parsedId)) {
    row = db.query('SELECT * FROM rooms WHERE id = ?').get(parsedId) as Record<
      string,
      unknown
    > | null;
    if (!row && typeof identifier === 'string') {
      row = db
        .query('SELECT * FROM rooms WHERE name = ? ORDER BY id DESC LIMIT 1')
        .get(identifier) as Record<string, unknown> | null;
    }
  } else if (typeof identifier === 'string' && identifier.startsWith('/')) {
    row = db
      .query('SELECT * FROM rooms WHERE path = ?')
      .get(identifier) as Record<string, unknown> | null;
  } else {
    row = db
      .query('SELECT * FROM rooms WHERE name = ? ORDER BY id DESC LIMIT 1')
      .get(identifier) as Record<string, unknown> | null;
  }

  if (!row) return undefined;
  return dbRoomToRoom(row);
}

export function getRoomByPath(path: string): Room | undefined {
  return getRoom(path);
}

export function getOrCreateRoom(path: string, name: string): Room {
  const db = getDb();
  const existing = getRoomByPath(path);

  if (existing) {
    if (existing.name !== name) {
      db.run('UPDATE rooms SET name = ? WHERE id = ?', [name, existing.id]);
    }
    return { ...existing, name };
  }

  const ts = now();
  const result = db.run(
    'INSERT INTO rooms (path, name, created_at) VALUES (?, ?, ?)',
    [path, name, ts],
  );
  return {
    id: Number(result.lastInsertRowid),
    path,
    name,
    topic: null,
    created_at: ts,
  };
}

export function getAllRooms(): Room[] {
  const db = getDb();
  const rows = db.query('SELECT * FROM rooms ORDER BY id').all() as Record<
    string,
    unknown
  >[];
  return rows.map(dbRoomToRoom);
}

export function getRoomReminderDispatchCount(roomName: string): number {
  const row = getDb()
    .query(
      'SELECT reminder_dispatch_count FROM rooms WHERE name = ? ORDER BY id DESC LIMIT 1',
    )
    .get(roomName) as { reminder_dispatch_count: number } | null;
  return row?.reminder_dispatch_count ?? 0;
}

export function incrementRoomReminderDispatchCount(roomName: string): void {
  getDb().run(
    'UPDATE rooms SET reminder_dispatch_count = reminder_dispatch_count + 1 WHERE name = ?',
    [roomName],
  );
}

export function resetRoomReminderDispatchCount(roomName: string): void {
  getDb().run('UPDATE rooms SET reminder_dispatch_count = 0 WHERE name = ?', [
    roomName,
  ]);
}

export function getAgentByRoomAndName(
  roomId: number,
  name: string,
): Agent | undefined {
  const db = getDb();
  const row = db
    .query(`
    SELECT a.*, r.path as room_path, r.name as room_name
    FROM agents a
    JOIN rooms r ON r.id = a.room_id
    WHERE a.room_id = ? AND a.name = ?
  `)
    .get(roomId, name) as Record<string, unknown> | null;

  if (!row) return undefined;
  return dbRowToAgent(row);
}

export function getAgentByPane(pane: string): Agent | undefined {
  const db = getDb();
  const row = db
    .query(`
    SELECT a.*, r.path as room_path, r.name as room_name
    FROM agents a
    JOIN rooms r ON r.id = a.room_id
    WHERE a.pane = ?
    ORDER BY a.id DESC
    LIMIT 1
  `)
    .get(pane) as Record<string, unknown> | null;

  if (!row) return undefined;
  return dbRowToAgent(row);
}

export function getAgentBySessionId(sessionId: string): Agent | undefined {
  const db = getDb();
  const row = db
    .query(
      'SELECT agent_name FROM hook_events WHERE session_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(sessionId) as { agent_name: string } | null;
  if (!row) return undefined;
  return getAgent(row.agent_name);
}

export function getRoomMembers(roomId: number): Agent[] {
  const db = getDb();
  const rows = db
    .query(`
    SELECT a.*, r.path as room_path, r.name as room_name
    FROM agents a
    JOIN rooms r ON r.id = a.room_id
    WHERE a.room_id = ?
    ORDER BY a.registered_at
  `)
    .all(roomId) as Record<string, unknown>[];

  return rows.map(dbRowToAgent);
}

export function setRoomTopic(roomName: string, topic: string): boolean {
  const room = getRoom(roomName);
  if (!room) return false;
  const changes = getDb().run('UPDATE rooms SET topic = ? WHERE id = ?', [
    topic,
    room.id,
  ]).changes;
  return changes > 0;
}

export function isNameTakenInRoom(name: string, room: string): boolean {
  const roomObj = getRoom(room);
  if (!roomObj) return false;
  const row = getDb()
    .query('SELECT 1 FROM agents WHERE room_id = ? AND name = ?')
    .get(roomObj.id, name);
  return row !== null;
}

// --- Message operations ---

export function addMessage(
  _to: string,
  from: string,
  room: string,
  text: string,
  targetName: string | null,
  replyTo?: number | null,
  _metadata?: MessageDeliveryMetadata,
): Message {
  const db = getDb();
  const ts = now();
  const roomObj = getRoom(room);
  if (!roomObj) {
    throw new Error(`Room not found: ${room}`);
  }

  const insert = db.transaction(() => {
    const stmt = db.run(
      'INSERT INTO messages (room_id, sender, recipient, text, timestamp, reply_to, batch_id, worker_name, prompt_file, manifest_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        roomObj.id,
        from,
        targetName,
        text,
        ts,
        replyTo ?? null,
        _metadata?.batch_id ?? null,
        _metadata?.worker_name ?? null,
        _metadata?.prompt_file ?? null,
        _metadata?.manifest_order ?? null,
      ],
    );

    return stmt.lastInsertRowid;
  });

  const rowid = insert();
  const row = db
    .query('SELECT * FROM messages WHERE id = ?')
    .get(rowid) as Record<string, unknown>;
  return rowToMessage(row);
}

export function getRoomMessages(
  room: string,
  sinceSequence?: number,
  limit?: number,
): Message[] {
  const db = getDb();
  const roomObj = getRoom(room);
  if (!roomObj) return [];

  let sql = 'SELECT * FROM messages WHERE room_id = ?';
  const params: unknown[] = [roomObj.id];
  if (sinceSequence !== undefined) {
    sql += ' AND id > ?';
    params.push(sinceSequence);
  }
  sql += ' ORDER BY id';
  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }
  return (db.query(sql).all(...params) as Record<string, unknown>[]).map(
    rowToMessage,
  );
}

export function getCursor(agentName: string, _room: string): number {
  const agent = getAgent(agentName);
  if (!agent) return 0;
  const row = getDb()
    .query('SELECT last_seq FROM cursors WHERE agent_id = ?')
    .get(agent.agent_id) as { last_seq: number } | null;
  return row?.last_seq ?? 0;
}

export function advanceCursor(
  agentName: string,
  _room: string,
  sequence: number,
): void {
  const agent = getAgent(agentName);
  if (!agent) return;

  const current = getCursor(agentName, '');
  if (sequence > current) {
    getDb().run(
      'INSERT OR REPLACE INTO cursors (agent_id, last_seq) VALUES (?, ?)',
      [agent.agent_id, sequence],
    );
  }
}

export function getPushCursor(agentName: string): number {
  const agent = getAgent(agentName);
  if (!agent) return 0;
  const row = getDb()
    .query('SELECT last_seq FROM push_cursors WHERE agent_id = ?')
    .get(agent.agent_id) as { last_seq: number } | null;
  return row?.last_seq ?? 0;
}

export function advancePushCursor(agentName: string, sequence: number): void {
  const agent = getAgent(agentName);
  if (!agent) return;

  const current = getPushCursor(agentName);
  if (sequence > current) {
    getDb().run(
      'INSERT OR REPLACE INTO push_cursors (agent_id, last_seq) VALUES (?, ?)',
      [agent.agent_id, sequence],
    );
  }
}

export function readRoomMessages(
  agentName: string,
  room: string,
  limit = 50,
): { messages: Message[]; next_sequence: number } {
  const db = getDb();
  const roomObj = getRoom(room);
  if (!roomObj) return { messages: [], next_sequence: 0 };

  const cursor = getCursor(agentName, room);

  // If input block mode is active, do not return any new messages
  const blockMode = getAgentInputBlockMode(agentName);
  if (blockMode !== 'off') {
    return { messages: [], next_sequence: cursor };
  }

  // Return messages addressed to this agent AND broadcast messages (recipient IS
  // NULL) within this room. Broadcasts include stop-hook completion messages
  // from workers. Broadcast visibility must mirror the push path
  // (delivery/index.ts `flushPushQueueForAgent`): a worker broadcast is
  // leader-audience only ("messages flow up the hierarchy"); a leader broadcast
  // is a room announcement everyone sees. A reader never sees its own broadcast.
  const reader = getAgentByRoomAndName(roomObj.id, agentName);
  const readerRole = reader?.role ?? 'leader';
  const sql = `
    SELECT m.* FROM messages m
    LEFT JOIN agents s ON s.name = m.sender AND s.room_id = m.room_id
    WHERE m.room_id = ? AND m.id > ? AND (
      m.recipient = ?
      OR (m.recipient IS NULL AND m.sender != ?
          AND (s.role IS NULL OR s.role != 'worker' OR ? = 'leader'))
    )
    ORDER BY m.id`;
  const params: unknown[] = [
    roomObj.id,
    cursor,
    agentName,
    agentName,
    readerRole,
  ];
  const allMsgs = (
    db.query(sql).all(...params) as Record<string, unknown>[]
  ).map(rowToMessage);
  const msgs = allMsgs.length > limit ? allMsgs.slice(-limit) : allMsgs;
  const maxSeq = msgs.length > 0 ? msgs[msgs.length - 1]?.sequence : cursor;
  advanceCursor(agentName, room, maxSeq);
  return { messages: msgs, next_sequence: maxSeq };
}

export function readMessages(
  agentName: string,
  room?: string,
  sinceSequence?: number,
): { messages: Message[]; next_sequence: number } {
  const db = getDb();

  // If input block mode is active, do not return any messages
  const blockMode = getAgentInputBlockMode(agentName);
  if (blockMode !== 'off') {
    return { messages: [], next_sequence: sinceSequence ?? 0 };
  }

  let sql = 'SELECT * FROM messages WHERE recipient = ?';
  const params: unknown[] = [agentName];
  if (room) {
    const roomObj = getRoom(room);
    if (!roomObj) return { messages: [], next_sequence: sinceSequence ?? 0 };
    sql += ' AND room_id = ?';
    params.push(roomObj.id);
  }
  if (sinceSequence !== undefined) {
    sql += ' AND id > ?';
    params.push(sinceSequence);
  }
  sql += ' ORDER BY id';
  const msgs = (db.query(sql).all(...params) as Record<string, unknown>[]).map(
    rowToMessage,
  );
  const maxSeq =
    msgs.length > 0 ? msgs[msgs.length - 1]?.sequence : (sinceSequence ?? 0);
  return { messages: msgs, next_sequence: maxSeq };
}

export function getAllMessages(): Message[] {
  return (
    getDb().query('SELECT * FROM messages ORDER BY id').all() as Record<
      string,
      unknown
    >[]
  ).map(rowToMessage);
}

// --- Refresh / migration ---

export async function refreshAgent(
  roomId: number,
  name: string,
  newPane: string,
): Promise<Agent | undefined> {
  const db = getDb();

  const existing = db
    .query('SELECT id FROM agents WHERE room_id = ? AND name = ?')
    .get(roomId, name) as { id: number } | null;

  if (!existing) return undefined;

  const paneOwner = db
    .query('SELECT id FROM agents WHERE pane = ?')
    .get(newPane) as { id: number } | null;
  if (paneOwner && paneOwner.id !== existing.id) {
    db.run('UPDATE agents SET pane = NULL WHERE id = ?', [paneOwner.id]);
  }

  db.run('UPDATE agents SET pane = ?, last_activity = ? WHERE id = ?', [
    newPane,
    new Date().toISOString(),
    existing.id,
  ]);

  return getAgentByRoomAndName(roomId, name);
}

// --- Liveness ---

/** Remove an agent from the registry when its pane is stale. */
export function markAgentStale(agentName: string): void {
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
      if (!(await paneCommandLooksAlive(agent.tmux_target))) {
        markAgentStale(agent.name);
        dead.push(agent.name);
      }
    }
  }
  return dead;
}

// --- Token usage operations ---

export function recordTokenUsage(
  entry: Omit<TokenUsage, 'id' | 'recorded_at'>,
): void {
  const db = getDb();
  db.run(
    `INSERT INTO token_usage (agent_id, session_id, model, input_tokens, output_tokens, cost_usd, source, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(agent_id) DO UPDATE SET
       session_id=excluded.session_id,
       model=excluded.model,
       input_tokens=excluded.input_tokens,
       output_tokens=excluded.output_tokens,
       cost_usd=excluded.cost_usd,
       source=excluded.source,
       recorded_at=CURRENT_TIMESTAMP`,
    [
      entry.agent_id,
      entry.session_id ?? null,
      entry.model ?? null,
      entry.input_tokens,
      entry.output_tokens,
      entry.cost_usd ?? null,
      entry.source,
    ],
  );
}

export function getTokenUsageForAgent(agentName: string): TokenUsage[] {
  const db = getDb();
  return db
    .query(`
    SELECT tu.* FROM token_usage tu
    JOIN agents a ON a.id = tu.agent_id
    WHERE a.name = ?
    ORDER BY tu.recorded_at DESC
  `)
    .all(agentName) as TokenUsage[];
}

export function getLatestTokenUsage(agentName: string): TokenUsage | null {
  const db = getDb();
  return (
    (db
      .query(`
    SELECT tu.* FROM token_usage tu
    JOIN agents a ON a.id = tu.agent_id
    WHERE a.name = ?
    ORDER BY tu.recorded_at DESC LIMIT 1
  `)
      .get(agentName) as TokenUsage) ?? null
  );
}

export function getAgentMessageCounts(name: string): {
  sent: number;
  received: number;
} {
  const db = getDb();
  const sent =
    (
      db
        .query('SELECT COUNT(*) as cnt FROM messages WHERE "from" = ?')
        .get(name) as any
    )?.cnt ?? 0;
  const received =
    (
      db
        .query('SELECT COUNT(*) as cnt FROM messages WHERE "to" = ?')
        .get(name) as any
    )?.cnt ?? 0;
  return { sent, received };
}

export function getTotalCost(): number {
  const db = getDb();
  const row = db
    .query('SELECT SUM(cost_usd) as total FROM token_usage')
    .get() as any;
  return row?.total ?? 0;
}

export function getAgentCost(agentName: string): number {
  const db = getDb();
  const row = db
    .query(`
    SELECT SUM(tu.cost_usd) as total FROM token_usage tu
    JOIN agents a ON a.id = tu.agent_id
    WHERE a.name = ?
  `)
    .get(agentName) as any;
  return row?.total ?? 0;
}

export function getPricing(): PricingEntry[] {
  const db = getDb();
  return db
    .query('SELECT * FROM pricing ORDER BY model_name')
    .all() as PricingEntry[];
}

export function upsertPricing(
  modelName: string,
  inputCostPerMillion: number,
  outputCostPerMillion: number,
): void {
  const db = getDb();
  db.run(
    'INSERT INTO pricing (model_name, input_cost_per_million, output_cost_per_million) VALUES (?, ?, ?) ON CONFLICT(model_name) DO UPDATE SET input_cost_per_million = excluded.input_cost_per_million, output_cost_per_million = excluded.output_cost_per_million',
    [modelName, inputCostPerMillion, outputCostPerMillion],
  );
}

export function getPricingForModel(modelName: string): PricingEntry | null {
  const db = getDb();
  return (
    (db
      .query('SELECT * FROM pricing WHERE model_name = ?')
      .get(modelName) as PricingEntry) ?? null
  );
}

// --- Hook events ---

// Dedup guard: Claude Code fires the same hook event multiple times per turn.
const DEDUP_WINDOW_MS = 2000;
const dedupCache = new Map<string, number>();

function isDuplicateEvent(
  agentName: string,
  eventType: string,
  sessionId: string | null,
  payload: string,
): boolean {
  if (eventType !== 'UserPromptSubmit') return false;
  const fp =
    payload.length > 200 ? payload.slice(0, 200) + payload.length : payload;
  const key = `${agentName}:${eventType}:${sessionId}:${fp}`;
  const now = Date.now();
  const last = dedupCache.get(key);
  dedupCache.set(key, now);
  return last !== undefined && now - last < DEDUP_WINDOW_MS;
}

export function addHookEvent(
  agentName: string,
  eventType: string,
  sessionId: string | null,
  payload: string,
  roomId?: number,
): number {
  const db = getDb();
  if (isDuplicateEvent(agentName, eventType, sessionId, payload)) {
    const row = db
      .query(
        'SELECT id FROM hook_events WHERE agent_name = ? AND event_type = ? ORDER BY id DESC LIMIT 1',
      )
      .get(agentName, eventType) as { id: number } | null;
    return row?.id ?? 0;
  }
  const stmt = db.run(
    'INSERT INTO hook_events (agent_name, event_type, session_id, payload) VALUES (?, ?, ?, ?)',
    [agentName, eventType, sessionId, payload],
  );
  const eventId = Number(stmt.lastInsertRowid);
  const newStatus: 'idle' | 'busy' = eventType === 'Stop' ? 'idle' : 'busy';
  const resolvedAgent =
    roomId !== undefined
      ? (getAgentByRoomAndName(roomId, agentName) ?? getAgent(agentName))
      : getAgent(agentName);
  if (resolvedAgent) {
    db.run('UPDATE agents SET status = ? WHERE id = ?', [
      newStatus,
      resolvedAgent.agent_id,
    ]);
  }

  // Party mode integration: capture response on Stop
  if (eventType === 'Stop') {
    capturePartyResponseIfActive(agentName, payload, eventId, roomId);
    // Room mode: auto-notify leaders (skips if party mode active)
    notifyLeadersOnWorkerStop(agentName, payload, roomId);
  }

  return eventId;
}

function capturePartyResponseIfActive(
  agentName: string,
  payload: string,
  hookEventId: number,
  roomId?: number,
): void {
  const agent =
    roomId !== undefined
      ? (getAgentByRoomAndName(roomId, agentName) ?? getAgent(agentName))
      : getAgent(agentName);
  if (!agent || agent.role !== 'worker') return;

  const partyState = getPartyState(agent.room_id);
  if (!partyState?.active) return;

  let response = '';
  try {
    const parsed = JSON.parse(payload) as { last_assistant_message?: string };
    response = parsed.last_assistant_message ?? '';
  } catch {
    return;
  }

  if (!response.trim()) return;

  addPartyResponse(
    agent.room_id,
    partyState.round,
    agentName,
    response,
    hookEventId,
  );

  // Check if round complete → notify leader (async, fire-and-forget)
  checkAndNotifyRoundComplete(agent.room_id, partyState.round);
}

function checkAndNotifyRoundComplete(roomId: number, round: number): void {
  if (!isPartyRoundComplete(roomId, round)) return;

  const responses = getPartyResponses(roomId, round);
  const leaders = getRoomMembers(roomId).filter((m) => m.role === 'leader');

  // Dynamic import to avoid circular deps, fire-and-forget
  import('../delivery/party-delivery.ts').then(({ deliverPartyDigest }) =>
    deliverPartyDigest(roomId, round, responses, leaders),
  );
}

/**
 * Queue a final batch delivery using the existing push/deferred path.
 */
export async function queueBatchFinalDelivery(
  batchId: string,
  leaderName: string,
  roomId: number,
  rendered: string,
): Promise<void> {
  const room = getRoom(roomId);
  if (!room) return;

  const { deliverMessage } = await import('../delivery/index.ts');
  await deliverMessage('system', room.name, rendered, leaderName, undefined, {
    batch_id: batchId,
  });
}

/**
 * Auto-notify leaders when worker completes (room mode, not party mode).
 * Fire-and-forget: doesn't block hook processing.
 * Includes retry logic to handle race with leader prompt submissions.
 */
function notifyLeadersOnWorkerStop(
  agentName: string,
  payload: string,
  roomId?: number,
): void {
  const agent =
    roomId !== undefined
      ? (getAgentByRoomAndName(roomId, agentName) ?? getAgent(agentName))
      : getAgent(agentName);
  if (!agent || agent.role !== 'worker') return;

  // Skip if party mode is active — party has its own notification flow
  const partyState = getPartyState(agent.room_id);
  if (partyState?.active) return;

  // Extract response
  let response = '';
  try {
    const parsed = JSON.parse(payload) as { last_assistant_message?: string };
    response = parsed.last_assistant_message ?? '';
  } catch {
    return;
  }

  // Active worker goals are a completion gate: Stop reminders still fire for
  // the worker, but leader-facing completion delivery waits until the goal is
  // explicitly done or unset.
  try {
    const goal = getGoalByAgent(agentName, agent.room_id);
    if (goal?.status === 'active') return;
  } catch {
    // Fail-open: don't block completion delivery on goal lookup errors
  }

  const batchTerminal = recordBatchWorkerTerminalMessage({
    workerName: agentName,
    roomId: agent.room_id,
    terminalStatus: 'success',
    finalMessage: response,
  });
  if (batchTerminal) {
    if (batchTerminal.shouldFinalize) {
      const rendered = renderBatchFinalMessage(
        getRenderableBatchWorkers(batchTerminal.batchId),
      );
      void queueBatchFinalDelivery(
        batchTerminal.batchId,
        batchTerminal.leaderName,
        batchTerminal.roomId,
        rendered,
      ).catch((e) => {
        console.error(
          `[crew batch] final delivery failed for ${batchTerminal.batchId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }
    return;
  }

  const latestBatch = getLatestBatchForWorker(agentName, agent.room_id);
  const latestSubmit = getLatestHookEvent(agentName, 'UserPromptSubmit');
  const hasNewerTurnThanLatestBatch =
    Boolean(latestSubmit && latestBatch?.finished_at) &&
    new Date(`${latestSubmit!.created_at}Z`).getTime() >
      new Date(latestBatch!.finished_at!).getTime();
  if (
    latestBatch &&
    latestBatch.terminal_status !== 'running' &&
    latestBatch.final_message === response &&
    !hasNewerTurnThanLatestBatch
  ) {
    return;
  }

  if (!response.trim()) return;

  // Turn-scoped dedup: if worker already sent a notifiable message since
  // their last UserPromptSubmit, crew send handled it — Stop hook should skip.
  if (alreadyNotifiedThisTurn(agent.room_id, agentName)) return;

  // Pane previews are capped (notifyMaxChars) to avoid overwhelming the
  // leader's tmux pane, but the FULL response is stored in the DB so that
  // `crew read` returns the complete report — the leader no longer needs a
  // follow-up `crew inspect` just to recover capped content.
  const truncated = truncateForNotification(response, config.notifyMaxChars);
  const room = getRoom(agent.room_id);
  const roomName = room?.name ?? 'unknown';

  // Record the FULL completion message in DB (always, even if leader has no pane)
  const msg = addMessage(
    roomName,
    agentName,
    roomName,
    response,
    null, // broadcast to room
  );

  // Deliver a CAPPED preview to leaders' tmux panes via the shared queue so
  // queue-drain semantics stay consistent with other leader-targeted messages.
  const leaders = getRoomMembers(agent.room_id).filter(
    (m) => m.role === 'leader' && m.tmux_target,
  );
  const message = `[${agentName}@${roomName}] completed:\n${truncated}`;

  for (const leader of leaders) {
    deliverWithRetry(leader, message, msg.sequence).catch(() => {});
  }
}

/**
 * Deliver notification to leader with retry if they're busy.
 * Waits if leader recently submitted a prompt (race condition avoidance).
 */
async function deliverWithRetry(
  leader: Agent,
  message: string,
  sequence: number,
): Promise<void> {
  const RETRY_DELAY_MS = 1500;
  const MAX_RETRIES = 2;

  if (getAgentInputBlockMode(leader.name) !== 'off') {
    return;
  }

  // Check if leader is currently busy (recent UserPromptSubmit event)
  const latestEvent = getLatestHookEvent(leader.name);
  if (latestEvent?.event_type === 'UserPromptSubmit') {
    const eventAge =
      Date.now() - new Date(`${latestEvent.created_at}Z`).getTime();
    // If leader submitted within last 2s, wait for them to settle
    if (eventAge < 2000) {
      await Bun.sleep(RETRY_DELAY_MS);
    }
  }

  const { getQueue } = await import('../delivery/pane-queue.ts');

  // Try delivery with retries
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (getAgentInputBlockMode(leader.name) !== 'off') {
      return;
    }

    try {
      await getQueue(leader.tmux_target!, { role: leader.role }).enqueue({
        type: 'paste',
        text: message,
        skipLeaderPacing: true,
        onQueueDrain: () => {
          armLeaderGoalReminder(leader.name, leader.room_id);
        },
      });
      advancePushCursor(leader.name, sequence);
      return;
    } catch {
      if (attempt < MAX_RETRIES) {
        await Bun.sleep(RETRY_DELAY_MS);
      }
    }
  }
}

/**
 * Turn-scoped dedup: check if worker already sent ANY message (including chat)
 * during the current turn. A turn starts at UserPromptSubmit and ends at Stop.
 *
 * If the worker actively sent a message via `crew send`, it already reached
 * the leader through push delivery — the Stop hook should not send a
 * duplicate notification.
 *
 * Uses julianday() for sub-second precision comparison, avoiding format
 * mismatches between messages.timestamp (ISO 8601 with ms) and
 * hook_events.created_at (SQLite datetime, second precision).
 */
function alreadyNotifiedThisTurn(roomId: number, agentName: string): boolean {
  const db = getDb();
  // Find the most recent UserPromptSubmit for this agent
  const lastPrompt = db
    .query(
      `SELECT created_at FROM hook_events
       WHERE agent_name = ? AND event_type = 'UserPromptSubmit'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(agentName) as { created_at: string } | null;

  if (!lastPrompt) return false;

  // Check for ANY message from this agent after the last prompt.
  // Any message sent via `crew send` means the worker actively communicated —
  // the Stop hook should skip to avoid duplicate leader notifications.
  const row = db
    .query(
      `SELECT 1 FROM messages
       WHERE room_id = ? AND sender = ?
       AND julianday(timestamp) > julianday(?)
       LIMIT 1`,
    )
    .get(roomId, agentName, lastPrompt.created_at);
  return row !== null;
}

function truncateForNotification(text: string, maxLen: number): string {
  const cleaned = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');

  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 3)}...`;
}

export function getLatestHookEvent(
  agentName: string,
  eventType?: string,
  sessionId?: string,
): HookEvent | null {
  const db = getDb();
  let sql = 'SELECT * FROM hook_events WHERE agent_name = ?';
  const params: unknown[] = [agentName];
  if (eventType) {
    sql += ' AND event_type = ?';
    params.push(eventType);
  }
  if (sessionId) {
    sql += ' AND session_id = ?';
    params.push(sessionId);
  }
  sql += ' ORDER BY id DESC LIMIT 1';
  const row = db.query(sql).get(...params) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    id: row.id as number,
    agent_name: row.agent_name as string,
    event_type: row.event_type as string,
    session_id: (row.session_id as string | null) ?? null,
    payload: (row.payload as string | null) ?? null,
    created_at: row.created_at as string,
  };
}

export function getAgentHookStatus(
  agentName: string,
): 'idle' | 'busy' | 'unknown' {
  const event = getLatestHookEvent(agentName);
  if (!event) return 'unknown';
  return event.event_type === 'Stop' ? 'idle' : 'busy';
}

export function getRecentHookEvents(
  sinceId: number = 0,
  limit: number = 100,
): HookEvent[] {
  const db = getDb();
  return db
    .query('SELECT * FROM hook_events WHERE id > ? ORDER BY id LIMIT ?')
    .all(sinceId, limit) as HookEvent[];
}

// --- Change detection ---

export function getChangeVersions(
  scopes: string[],
): Record<string, { version: number; updated_at: string }> {
  const db = getDb();
  const result: Record<string, { version: number; updated_at: string }> = {};
  for (const scope of scopes) {
    const row = db
      .query('SELECT version, updated_at FROM change_log WHERE scope = ?')
      .get(scope) as { version: number; updated_at: string } | null;
    if (row) result[scope] = row;
  }
  return result;
}

// --- Template reads ---

export function getAllTemplates(): AgentTemplate[] {
  return getDb()
    .query('SELECT * FROM agent_templates ORDER BY id')
    .all() as AgentTemplate[];
}

export function getRoomTemplateNames(room: string): string[] {
  const roomObj = getRoom(room);
  if (!roomObj) return [];
  return (
    getDb()
      .query(
        'SELECT t.name FROM agent_templates t JOIN room_templates rt ON rt.template_id=t.id WHERE rt.room_id=? ORDER BY t.id',
      )
      .all(roomObj.id) as { name: string }[]
  ).map((r) => r.name);
}

export function getAllRoomTemplates(): RoomTemplate[] {
  const rows = getDb()
    .query('SELECT * FROM room_template_definitions ORDER BY id')
    .all() as Array<{
    id: number;
    name: string;
    topic: string | null;
    agent_template_ids: string;
    created_at: string;
  }>;
  return rows.map((r) => ({
    ...r,
    agent_template_ids: JSON.parse(r.agent_template_ids) as number[],
  }));
}

export function getRoomTemplateDefinition(
  id: number,
): RoomTemplate | undefined {
  const row = getDb()
    .query('SELECT * FROM room_template_definitions WHERE id = ?')
    .get(id) as {
    id: number;
    name: string;
    topic: string | null;
    agent_template_ids: string;
    created_at: string;
  } | null;
  if (!row) return undefined;
  return {
    ...row,
    agent_template_ids: JSON.parse(row.agent_template_ids) as number[],
  };
}

export function getAgentTemplateById(id: number): AgentTemplate | undefined {
  return getDb().query('SELECT * FROM agent_templates WHERE id = ?').get(id) as
    | AgentTemplate
    | undefined;
}

// --- Party mode operations ---

export function bumpChangeLog(scope: string): void {
  getDb().run(
    'UPDATE change_log SET version = version + 1, updated_at = datetime("now") WHERE scope = ?',
    [scope],
  );
}

export function startParty(roomId: number, topic: string): void {
  const db = getDb();
  db.run(
    `UPDATE rooms SET party_active = 1, party_round = 1, party_topic = ?, party_started_at = datetime('now') WHERE id = ?`,
    [topic, roomId],
  );
  bumpChangeLog('party');
}

export function nextPartyRound(roomId: number, topic: string): number {
  const db = getDb();
  // Use transaction to ensure atomicity
  const result = db.transaction(() => {
    db.run(
      `UPDATE rooms SET party_round = party_round + 1, party_topic = ?, party_started_at = datetime('now') WHERE id = ?`,
      [topic, roomId],
    );
    const row = db
      .query('SELECT party_round FROM rooms WHERE id = ?')
      .get(roomId) as { party_round: number };
    return row.party_round;
  })();
  bumpChangeLog('party');
  return result;
}

export function endParty(roomId: number): void {
  const db = getDb();
  db.run(
    `UPDATE rooms SET party_active = 0, party_topic = NULL, party_started_at = NULL WHERE id = ?`,
    [roomId],
  );
  // Clear responses for this room
  db.run('DELETE FROM party_responses WHERE room_id = ?', [roomId]);
  bumpChangeLog('party');
}

export function getPartyState(roomId: number): PartyState | null {
  const db = getDb();
  const row = db
    .query(
      'SELECT party_active, party_round, party_topic, party_started_at FROM rooms WHERE id = ?',
    )
    .get(roomId) as {
    party_active: number;
    party_round: number;
    party_topic: string | null;
    party_started_at: string | null;
  } | null;
  if (!row) return null;
  return {
    active: row.party_active === 1,
    round: row.party_round,
    topic: row.party_topic,
    started_at: row.party_started_at,
  };
}

export function addPartyResponse(
  roomId: number,
  round: number,
  agentName: string,
  response: string,
  hookEventId: number | null,
): number {
  const db = getDb();
  const stmt = db.run(
    `INSERT INTO party_responses (room_id, round, agent_name, response, hook_event_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(room_id, round, agent_name) DO UPDATE SET response = excluded.response, hook_event_id = excluded.hook_event_id`,
    [roomId, round, agentName, response, hookEventId],
  );
  bumpChangeLog('party');
  return Number(stmt.lastInsertRowid);
}

export function getPartyResponses(
  roomId: number,
  round: number,
): PartyResponse[] {
  const db = getDb();
  return db
    .query(
      'SELECT * FROM party_responses WHERE room_id = ? AND round = ? ORDER BY created_at',
    )
    .all(roomId, round) as PartyResponse[];
}

export function getPendingPartyWorkers(
  roomId: number,
  round: number,
): string[] {
  const db = getDb();
  const responded = db
    .query(
      'SELECT agent_name FROM party_responses WHERE room_id = ? AND round = ?',
    )
    .all(roomId, round) as { agent_name: string }[];
  const respondedNames = new Set(responded.map((r) => r.agent_name));

  const workers = db
    .query(`SELECT name FROM agents WHERE room_id = ? AND role = 'worker'`)
    .all(roomId) as { name: string }[];

  return workers.filter((w) => !respondedNames.has(w.name)).map((w) => w.name);
}

export function isPartyRoundComplete(roomId: number, round: number): boolean {
  return getPendingPartyWorkers(roomId, round).length === 0;
}

export function skipPartyWorker(
  roomId: number,
  round: number,
  agentName: string,
): void {
  addPartyResponse(roomId, round, agentName, '[SKIPPED]', null);
}

export function getAgentByName(name: string): Agent | undefined {
  return getAgent(name);
}

export function getActivePartyRooms(): Array<{
  id: number;
  name: string;
  party_round: number;
  party_started_at: string;
}> {
  const db = getDb();
  return db
    .query(
      `SELECT id, name, party_round, party_started_at FROM rooms WHERE party_active = 1`,
    )
    .all() as Array<{
    id: number;
    name: string;
    party_round: number;
    party_started_at: string;
  }>;
}

// --- Registered-agent hint operations ---

export interface HintRecord {
  id: number;
  agent_name: string;
  pane_bootstrap: string | null;
  session_id: string | null;
  room_id: number;
  turn_count: number;
  message: string;
  cadence: number;
  created_at: string;
  updated_at: string;
}

/**
 * Set a hint for an agent. Creates a pane-bootstrap record that will later
 * be migrated to a session-bound record when session_id is available.
 * Message is required — it's the text injected into the agent's conversation.
 * Cadence controls how often (every N turns) the hint fires (default 3).
 */
export function setHint(
  agentName: string,
  roomId: number,
  message: string,
  options?: { pane?: string; cadence?: number },
): HintRecord {
  const db = getDb();
  const ts = now();
  const agent = getAgentByRoomAndName(roomId, agentName);
  if (!agent) {
    throw new Error(`Agent not found: ${agentName} in room ${roomId}`);
  }

  const pane = options?.pane ?? agent.tmux_target ?? null;
  const cadence = options?.cadence ?? 3;

  // DELETE + INSERT as a single transaction so concurrent setHint calls
  // cannot leave a window with no row.
  const result = db.transaction(() => {
    db.run('DELETE FROM agent_hints WHERE agent_name = ? AND room_id = ?', [
      agentName,
      roomId,
    ]);
    const stmt = db.run(
      'INSERT INTO agent_hints (agent_name, pane_bootstrap, session_id, room_id, turn_count, message, cadence, created_at, updated_at) VALUES (?, ?, NULL, ?, 0, ?, ?, ?, ?)',
      [agentName, pane, roomId, message, cadence, ts, ts],
    );
    return Number(stmt.lastInsertRowid);
  })();
  bumpChangeLog('hints');

  return getHintById(result)!;
}

/**
 * Remove hint for an agent in a room. Clears both pane-bootstrap and session-bound records.
 */
export function unsetHint(agentName: string, roomId: number): boolean {
  const db = getDb();
  const result = db.run(
    'DELETE FROM agent_hints WHERE agent_name = ? AND room_id = ?',
    [agentName, roomId],
  );
  if (result.changes > 0) bumpChangeLog('hints');
  return result.changes > 0;
}

/**
 * Get hint by pane (bootstrap) or session_id (canonical).
 * Returns null if no hint exists.
 */
export function getHint(
  pane: string | null,
  sessionId: string | null,
  roomId?: number,
): HintRecord | null {
  const db = getDb();
  const roomFilter = roomId ? ' AND room_id = ?' : '';
  const roomArgs: (string | number)[] = roomId ? [roomId] : [];
  let row: Record<string, unknown> | null = null;

  if (sessionId) {
    // When session is provided, match only by session_id — don't fall through
    // to pane. This ensures getHint(pane, 'old-session') returns null after
    // the session is rotated, even though pane_bootstrap is still populated.
    row = db
      .query(`SELECT * FROM agent_hints WHERE session_id = ?${roomFilter}`)
      .get(sessionId, ...roomArgs) as Record<string, unknown> | null;
  } else if (pane) {
    // No session — look up by pane_bootstrap only.
    // Works after canonicalization since we keep pane_bootstrap populated.
    row = db
      .query(`SELECT * FROM agent_hints WHERE pane_bootstrap = ?${roomFilter}`)
      .get(pane, ...roomArgs) as Record<string, unknown> | null;
  }

  if (!row) return null;
  return rowToHint(row);
}

/**
 * Increment turn count and return whether to show hint (every 3rd turn).
 * Atomically increments the counter.
 */
export function tickHintCadence(
  pane: string,
  sessionId: string | null,
  roomId?: number,
): { shouldShow: boolean; hint: HintRecord | null } {
  const db = getDb();
  const ts = now();

  // Scope by room_id when available to prevent multi-room cross-contamination.
  const roomFilter = roomId ? ' AND room_id = ?' : '';
  const roomArgs: (string | number)[] = roomId ? [roomId] : [];

  if (sessionId) {
    const row = db
      .query(
        `UPDATE agent_hints
       SET turn_count = turn_count + 1, updated_at = ?
       WHERE id = COALESCE(
         (SELECT id FROM agent_hints WHERE session_id = ?${roomFilter}),
         (SELECT id FROM agent_hints WHERE pane_bootstrap = ?${roomFilter})
       )
       RETURNING *`,
      )
      .get(ts, sessionId, ...roomArgs, pane, ...roomArgs) as Record<
      string,
      unknown
    > | null;
    if (!row) return { shouldShow: false, hint: null };

    const hint = rowToHint(row);
    const shouldShow = hint.turn_count % hint.cadence === 0;
    return { shouldShow, hint: shouldShow ? hint : null };
  }

  const row = db
    .query(
      `UPDATE agent_hints
     SET turn_count = turn_count + 1, updated_at = ?
     WHERE pane_bootstrap = ?${roomFilter}
     RETURNING *`,
    )
    .get(ts, pane, ...roomArgs) as Record<string, unknown> | null;
  if (!row) return { shouldShow: false, hint: null };

  const hint = rowToHint(row);
  const shouldShow = hint.turn_count % hint.cadence === 0;
  return { shouldShow, hint: shouldShow ? hint : null };
}

/**
 * Canonicalize hint identity: migrate pane-bootstrap hint to session-bound.
 * Called from hook-event when session_id is first available.
 * Idempotent: safe to call multiple times for same session.
 */
export function canonicalizeHintIdentity(
  agentName: string,
  pane: string,
  sessionId: string,
): void {
  const db = getDb();
  const ts = now();

  // Scope operations by the agent's current room so multi-room setups (same
  // agent name registered in different rooms) don't cross-contaminate.
  const agent = getAgentByPane(pane);
  if (!agent || agent.name !== agentName) return;
  const roomId = agent.room_id;

  // Idempotent: this session is already canonicalized. Ensure pane_bootstrap
  // is preserved (in case setHint was re-run) and bail.
  const existing = db
    .query('SELECT id FROM agent_hints WHERE session_id = ? AND room_id = ?')
    .get(sessionId, roomId) as { id: number } | null;
  if (existing) {
    db.run(
      'UPDATE agent_hints SET pane_bootstrap = COALESCE(pane_bootstrap, ?), updated_at = ? WHERE id = ?',
      [pane, ts, existing.id],
    );
    bumpChangeLog('hints');
    return;
  }

  // Find any prior row for (agent, room). Prefer a pane-bootstrap match so
  // normal first-canonicalization migration wins; fall back to any stale
  // session-bound row so Claude restart on the same pane re-binds the hint
  // instead of orphaning it.
  const prior = db
    .query(
      `SELECT id FROM agent_hints
     WHERE agent_name = ? AND room_id = ?
     ORDER BY (pane_bootstrap = ?) DESC, updated_at DESC LIMIT 1`,
    )
    .get(agentName, roomId, pane) as { id: number } | null;
  if (!prior) return;

  // Rebind to new session. Keep pane_bootstrap so getHint(pane, null) still works
  // after canonicalization (BUG-3 fix). Preserve turn_count across Claude restarts.
  db.run('UPDATE agent_hints SET session_id = ?, updated_at = ? WHERE id = ?', [
    sessionId,
    ts,
    prior.id,
  ]);
  bumpChangeLog('hints');
}

/**
 * Get hint by database ID.
 */
function getHintById(id: number): HintRecord | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM agent_hints WHERE id = ?')
    .get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return rowToHint(row);
}

function rowToHint(row: Record<string, unknown>): HintRecord {
  return {
    id: row.id as number,
    agent_name: row.agent_name as string,
    pane_bootstrap: (row.pane_bootstrap as string | null) ?? null,
    session_id: (row.session_id as string | null) ?? null,
    room_id: row.room_id as number,
    turn_count: row.turn_count as number,
    message: (row.message as string) ?? '',
    cadence: (row.cadence as number) ?? 3,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

// --- Test helpers ---

export function clearState(): void {
  const db = getDb();
  db.exec(
    "DELETE FROM token_usage; DELETE FROM pricing; DELETE FROM party_responses; DELETE FROM hook_events; DELETE FROM agent_hints; DELETE FROM agent_goals; DELETE FROM leader_dialogs; DELETE FROM messages; DELETE FROM message_batch_workers; DELETE FROM message_batches; DELETE FROM cursors; DELETE FROM push_cursors; DELETE FROM room_templates; DELETE FROM rooms; DELETE FROM agents; UPDATE sweep_control SET delivery_paused = 0, pause_reason = NULL, busy_mode = 'auto', updated_at = datetime('now') WHERE id = 1;",
  );
}
