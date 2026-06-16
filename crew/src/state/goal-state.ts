import { getDb } from './db.ts';
import {
  bumpChangeLog,
  getAgentByPane,
  getAgentByRoomAndName,
  getRoomMembers,
} from './index.ts';
import { logServer } from '../shared/server-log.ts';

// --- Types ---

export interface GoalRecord {
  id: number;
  agent_name: string;
  room_id: number;
  description: string;
  status: string;
  pane_bootstrap: string | null;
  session_id: string | null;
  set_by: string;
  turn_count: number;
  leader_reminder_armed: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  pending_completion_message: string | null;
  pending_completion_batch_id: string | null;
  pending_completion_created_at: string | null;
}

// --- Helpers ---

function now(): string {
  return new Date().toISOString();
}

function rowToGoal(row: Record<string, unknown>): GoalRecord {
  return {
    id: row.id as number,
    agent_name: row.agent_name as string,
    room_id: row.room_id as number,
    description: row.description as string,
    status: row.status as string,
    pane_bootstrap: (row.pane_bootstrap as string | null) ?? null,
    session_id: (row.session_id as string | null) ?? null,
    set_by: (row.set_by as string) ?? 'self',
    turn_count: (row.turn_count as number) ?? 0,
    leader_reminder_armed: (row.leader_reminder_armed as number) ?? 0,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    completed_at: (row.completed_at as string | null) ?? null,
    pending_completion_message: (row.pending_completion_message as string | null) ?? null,
    pending_completion_batch_id: (row.pending_completion_batch_id as string | null) ?? null,
    pending_completion_created_at:
      (row.pending_completion_created_at as string | null) ?? null,
  };
}

export interface GoalPendingCompletion {
  message: string;
  batchId: string | null;
}

export function setGoalPendingCompletion(
  agentName: string,
  roomId: number,
  message: string,
  batchId?: string | null,
): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;

  const db = getDb();
  const ts = now();
  const result = db.run(
    `UPDATE agent_goals
     SET pending_completion_message = ?,
         pending_completion_batch_id = ?,
         pending_completion_created_at = ?,
         updated_at = ?
     WHERE agent_name = ? AND room_id = ? AND status = 'active'`,
    [
      trimmed,
      batchId?.trim() || null,
      ts,
      ts,
      agentName,
      roomId,
    ],
  );
  if (result.changes > 0) {
    bumpChangeLog('goals');
    logServer(
      'DEBUG',
      `[goal] pending-completion-set: ${agentName} room=${roomId} batch=${batchId ?? 'null'}`,
    );
  }
  return result.changes > 0;
}

export function consumeGoalPendingCompletion(
  agentName: string,
  roomId: number,
): GoalPendingCompletion | null {
  const db = getDb();
  const row = db
    .query(
      `SELECT id, pending_completion_message, pending_completion_batch_id
       FROM agent_goals
       WHERE agent_name = ? AND room_id = ?
         AND pending_completion_message IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(agentName, roomId) as
    | { id: number; pending_completion_message: string; pending_completion_batch_id: string | null }
    | null;
  if (!row) return null;

  db.run(
    `UPDATE agent_goals
     SET pending_completion_message = NULL,
         pending_completion_batch_id = NULL,
         pending_completion_created_at = NULL
     WHERE id = ?`,
    [row.id],
  );

  return {
    message: row.pending_completion_message,
    batchId: row.pending_completion_batch_id,
  };
}

// --- CRUD ---

/** Set a goal for an agent. Abandon any prior active goal (preserve history) + INSERT in a transaction. */
export function setGoal(
  agentName: string,
  roomId: number,
  description: string,
  options?: { pane?: string; setBy?: string },
): GoalRecord {
  const db = getDb();
  const ts = now();
  const agent = getAgentByRoomAndName(roomId, agentName);
  if (!agent) throw new Error(`Agent not found: ${agentName} in room ${roomId}`);

  const pane = options?.pane ?? agent.tmux_target ?? null;
  const setBy = options?.setBy ?? 'self';

  const id = db.transaction(() => {
    // Preserve history: retire every prior goal for this agent/room so the new
    // active goal can claim the pane/session unique-index slots. We move the
    // pane to a per-row sentinel (`__retired:<id>`) instead of NULLing it,
    // because the schema CHECK requires at least one of pane/session non-null.
    // The sentinel is globally unique (keyed by row id), so it never collides
    // with the new row's real pane or with another retired row. Active goals
    // become 'abandoned'; done goals keep their status (history only).
    db.run(
      `UPDATE agent_goals
       SET pane_bootstrap = '__retired:' || id,
           session_id = NULL,
           status = CASE WHEN status = 'active' THEN 'abandoned' ELSE status END,
           completed_at = CASE WHEN status = 'active' THEN ? ELSE completed_at END,
           updated_at = ?
       WHERE agent_name = ? AND room_id = ?`,
      [ts, ts, agentName, roomId],
    );
    const stmt = db.run(
      `INSERT INTO agent_goals (agent_name, room_id, description, status, pane_bootstrap, session_id, set_by, turn_count, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, NULL, ?, 0, ?, ?)`,
      [agentName, roomId, description, pane, setBy, ts, ts],
    );
    return Number(stmt.lastInsertRowid);
  })();

  const row = db
    .query('SELECT * FROM agent_goals WHERE id = ?')
    .get(id) as Record<string, unknown>;
  bumpChangeLog('goals');
  logServer('INFO', `[goal] set: ${agentName} room=${roomId} setBy=${setBy} desc="${description.slice(0, 60)}"`);
  return rowToGoal(row);
}

/** Remove goal for an agent in a room. */
export function unsetGoal(agentName: string, roomId: number): boolean {
  const db = getDb();
  const result = db.run(
    'DELETE FROM agent_goals WHERE agent_name = ? AND room_id = ?',
    [agentName, roomId],
  );
  if (result.changes > 0) {
    bumpChangeLog('goals');
    logServer('INFO', `[goal] unset: ${agentName} room=${roomId}`);
  }
  return result.changes > 0;
}

/** Get goal by pane (bootstrap) or session_id (canonical). session_id first, pane fallback. */
export function getGoal(
  pane: string | null,
  sessionId: string | null,
  roomId?: number,
): GoalRecord | null {
  const db = getDb();
  const roomFilter = roomId ? ' AND room_id = ?' : '';
  const roomArgs: (string | number)[] = roomId ? [roomId] : [];

  if (sessionId) {
    const row = db
      .query(`SELECT * FROM agent_goals WHERE session_id = ?${roomFilter}`)
      .get(sessionId, ...roomArgs) as Record<string, unknown> | null;
    if (row) return rowToGoal(row);
    // Don't fall through to pane — same as getHint behavior
    return null;
  }

  if (pane) {
    const row = db
      .query(`SELECT * FROM agent_goals WHERE pane_bootstrap = ?${roomFilter}`)
      .get(pane, ...roomArgs) as Record<string, unknown> | null;
    if (row) return rowToGoal(row);
  }

  return null;
}

/** Get goal by agent name + room. */
export function getGoalByAgent(
  agentName: string,
  roomId?: number,
): GoalRecord | null {
  const db = getDb();
  let sql = 'SELECT * FROM agent_goals WHERE agent_name = ?';
  const params: (string | number)[] = [agentName];
  if (roomId) {
    sql += ' AND room_id = ?';
    params.push(roomId);
  }
  sql += ' ORDER BY id DESC LIMIT 1';
  const row = db.query(sql).get(...params) as Record<string, unknown> | null;
  if (!row) return null;
  return rowToGoal(row);
}

/** Get a single goal by id (any status). Used by `goal redo <id>`. */
export function getGoalById(id: number): GoalRecord | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM agent_goals WHERE id = ?')
    .get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return rowToGoal(row);
}

/**
 * Recent goal history for a room (all statuses), newest first.
 * Optionally filtered by agent. Re-use pool = abandoned + done.
 */
export function getGoalHistory(
  roomId: number,
  options?: { agentName?: string; limit?: number },
): GoalRecord[] {
  const db = getDb();
  const limit = Math.max(1, Math.min(options?.limit ?? 20, 200));
  let sql = 'SELECT * FROM agent_goals WHERE room_id = ?';
  const params: (string | number)[] = [roomId];
  if (options?.agentName) {
    sql += ' AND agent_name = ?';
    params.push(options.agentName);
  }
  sql += ' ORDER BY updated_at DESC, id DESC LIMIT ?';
  params.push(limit);
  const rows = db.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToGoal);
}

/**
 * Latest goal per member of a room (active/done/abandoned), for the
 * `crew goal` room overview. Members without any goal are omitted.
 */
export function getRoomGoalOverview(
  roomId: number,
): Array<{ goal: GoalRecord }> {
  const members = getRoomMembers(roomId);
  const overview: Array<{ goal: GoalRecord }> = [];
  for (const m of members) {
    const latest = getGoalByAgent(m.name, roomId);
    if (latest) overview.push({ goal: latest });
  }
  // Active goals first, then newest updated
  overview.sort((a, b) => {
    const ai = a.goal.status === 'active' ? 0 : 1;
    const bi = b.goal.status === 'active' ? 0 : 1;
    if (ai !== bi) return ai - bi;
    return b.goal.updated_at.localeCompare(a.goal.updated_at);
  });
  return overview;
}

/** Mark goal as done. Sets status='done', completed_at=now. */
export function completeGoal(agentName: string, roomId: number): boolean {
  const db = getDb();
  const ts = now();
  const result = db.run(
    `UPDATE agent_goals SET status = 'done', completed_at = ?, updated_at = ?
     WHERE agent_name = ? AND room_id = ? AND status = 'active'`,
    [ts, ts, agentName, roomId],
  );
  if (result.changes > 0) {
    bumpChangeLog('goals');
    logServer('INFO', `[goal] done: ${agentName} room=${roomId}`);
  }
  return result.changes > 0;
}

/** Update goal description. */
export function updateGoalDescription(
  agentName: string,
  roomId: number,
  newDescription: string,
): boolean {
  const db = getDb();
  const ts = now();
  const result = db.run(
    `UPDATE agent_goals SET description = ?, updated_at = ?
     WHERE agent_name = ? AND room_id = ? AND status = 'active'`,
    [newDescription, ts, agentName, roomId],
  );
  if (result.changes > 0) {
    bumpChangeLog('goals');
    logServer('INFO', `[goal] update: ${agentName} room=${roomId} desc="${newDescription.slice(0, 60)}"`);
  }
  return result.changes > 0;
}

/** Increment turn count on every stop. Returns updated goal or null. */
export function tickGoalTurnCount(
  pane: string,
  sessionId: string | null,
  roomId?: number,
): GoalRecord | null {
  const db = getDb();
  const ts = now();
  const roomFilter = roomId ? ' AND room_id = ?' : '';
  const roomArgs: (string | number)[] = roomId ? [roomId] : [];

  const activeFilter = " AND status = 'active'";

  if (sessionId) {
    const row = db
      .query(
        `UPDATE agent_goals
         SET turn_count = turn_count + 1, updated_at = ?
         WHERE id = COALESCE(
           (SELECT id FROM agent_goals WHERE session_id = ?${roomFilter}${activeFilter}),
           (SELECT id FROM agent_goals WHERE pane_bootstrap = ?${roomFilter}${activeFilter})
         )
         RETURNING *`,
      )
      .get(ts, sessionId, ...roomArgs, pane, ...roomArgs) as Record<
      string,
      unknown
    > | null;
    if (row) {
      const goal = rowToGoal(row);
      logServer('DEBUG', `[goal] tick: ${goal.agent_name} turn=${goal.turn_count} session=${sessionId}`);
      return goal;
    }
    return null;
  }

  const row = db
    .query(
      `UPDATE agent_goals
       SET turn_count = turn_count + 1, updated_at = ?
       WHERE pane_bootstrap = ?${roomFilter}${activeFilter}
       RETURNING *`,
    )
    .get(ts, pane, ...roomArgs) as Record<string, unknown> | null;
  if (row) {
    const goal = rowToGoal(row);
    logServer('DEBUG', `[goal] tick: ${goal.agent_name} turn=${goal.turn_count} pane=${pane}`);
    return goal;
  }
  return null;
}

/** Canonicalize goal identity: migrate pane-bootstrap to session-bound. */
export function armLeaderGoalReminder(
  agentName: string,
  roomId: number,
): boolean {
  const db = getDb();
  const ts = now();
  const result = db.run(
    `UPDATE agent_goals
     SET leader_reminder_armed = 1, updated_at = ?
     WHERE agent_name = ? AND room_id = ? AND status = 'active'`,
    [ts, agentName, roomId],
  );
  if (result.changes > 0) {
    bumpChangeLog('goals');
    logServer('DEBUG', `[goal] arm-leader-reminder: ${agentName} room=${roomId}`);
  }
  return result.changes > 0;
}

export function consumeLeaderGoalReminder(
  pane: string,
  sessionId: string | null,
  roomId?: number,
): GoalRecord | null {
  const db = getDb();
  const ts = now();
  const roomFilter = roomId ? ' AND room_id = ?' : '';
  const roomArgs: (string | number)[] = roomId ? [roomId] : [];
  const activeFilter = " AND status = 'active' AND leader_reminder_armed = 1";

  if (sessionId) {
    const row = db
      .query(
        `UPDATE agent_goals
         SET leader_reminder_armed = 0, turn_count = turn_count + 1, updated_at = ?
         WHERE id = COALESCE(
           (SELECT id FROM agent_goals WHERE session_id = ?${roomFilter}${activeFilter}),
           (SELECT id FROM agent_goals WHERE pane_bootstrap = ?${roomFilter}${activeFilter})
         )
         RETURNING *`,
      )
      .get(ts, sessionId, ...roomArgs, pane, ...roomArgs) as Record<
      string,
      unknown
    > | null;
    if (row) {
      const goal = rowToGoal(row);
      logServer('DEBUG', `[goal] consume-leader-reminder: ${goal.agent_name} turn=${goal.turn_count} session=${sessionId}`);
      return goal;
    }
    return null;
  }

  const row = db
    .query(
      `UPDATE agent_goals
       SET leader_reminder_armed = 0, turn_count = turn_count + 1, updated_at = ?
       WHERE pane_bootstrap = ?${roomFilter}${activeFilter}
       RETURNING *`,
    )
    .get(ts, pane, ...roomArgs) as Record<string, unknown> | null;
  if (row) {
    const goal = rowToGoal(row);
    logServer('DEBUG', `[goal] consume-leader-reminder: ${goal.agent_name} turn=${goal.turn_count} pane=${pane}`);
    return goal;
  }
  return null;
}

export function canonicalizeGoalIdentity(
  agentName: string,
  pane: string,
  sessionId: string,
): void {
  const db = getDb();
  const ts = now();

  const agent = getAgentByPane(pane);
  if (!agent || agent.name !== agentName) return;
  const roomId = agent.room_id;

  // Idempotent: already canonicalized for this session
  const existing = db
    .query('SELECT id FROM agent_goals WHERE session_id = ? AND room_id = ?')
    .get(sessionId, roomId) as { id: number } | null;
  if (existing) {
    db.run(
      'UPDATE agent_goals SET pane_bootstrap = COALESCE(pane_bootstrap, ?), updated_at = ? WHERE id = ?',
      [pane, ts, existing.id],
    );
    bumpChangeLog('goals');
    return;
  }

  // Find prior row for (agent, room), prefer pane-bootstrap match
  const prior = db
    .query(
      `SELECT id FROM agent_goals
       WHERE agent_name = ? AND room_id = ?
       ORDER BY (pane_bootstrap = ?) DESC, updated_at DESC LIMIT 1`,
    )
    .get(agentName, roomId, pane) as { id: number } | null;
  if (!prior) return;

  db.run('UPDATE agent_goals SET session_id = ?, updated_at = ? WHERE id = ?', [
    sessionId,
    ts,
    prior.id,
  ]);
  bumpChangeLog('goals');
  logServer('INFO', `[goal] canonicalize: ${agentName} pane=${pane} → session=${sessionId}`);
}
