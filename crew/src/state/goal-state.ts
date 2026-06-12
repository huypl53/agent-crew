import { getDb } from './db.ts';
import {
  bumpChangeLog,
  getAgentByPane,
  getAgentByRoomAndName,
  getRoomMembers,
} from './index.ts';

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
  created_at: string;
  updated_at: string;
  completed_at: string | null;
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
    set_by: (row.set_by as string) ?? 'leader',
    turn_count: (row.turn_count as number) ?? 0,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    completed_at: (row.completed_at as string | null) ?? null,
  };
}

// --- CRUD ---

/** Set a goal for an agent. DELETE + INSERT in a transaction. */
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
    db.run('DELETE FROM agent_goals WHERE agent_name = ? AND room_id = ?', [
      agentName,
      roomId,
    ]);
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
  return rowToGoal(row);
}

/** Remove goal for an agent in a room. */
export function unsetGoal(agentName: string, roomId: number): boolean {
  const db = getDb();
  const result = db.run(
    'DELETE FROM agent_goals WHERE agent_name = ? AND room_id = ?',
    [agentName, roomId],
  );
  if (result.changes > 0) bumpChangeLog('goals');
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

/** Mark goal as done. Sets status='done', completed_at=now. */
export function completeGoal(agentName: string, roomId: number): boolean {
  const db = getDb();
  const ts = now();
  const result = db.run(
    `UPDATE agent_goals SET status = 'done', completed_at = ?, updated_at = ?
     WHERE agent_name = ? AND room_id = ? AND status = 'active'`,
    [ts, ts, agentName, roomId],
  );
  if (result.changes > 0) bumpChangeLog('goals');
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
  if (result.changes > 0) bumpChangeLog('goals');
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

  if (sessionId) {
    const row = db
      .query(
        `UPDATE agent_goals
         SET turn_count = turn_count + 1, updated_at = ?
         WHERE id = COALESCE(
           (SELECT id FROM agent_goals WHERE session_id = ?${roomFilter}),
           (SELECT id FROM agent_goals WHERE pane_bootstrap = ?${roomFilter})
         )
         RETURNING *`,
      )
      .get(ts, sessionId, ...roomArgs, pane, ...roomArgs) as Record<
      string,
      unknown
    > | null;
    return row ? rowToGoal(row) : null;
  }

  const row = db
    .query(
      `UPDATE agent_goals
       SET turn_count = turn_count + 1, updated_at = ?
       WHERE pane_bootstrap = ?${roomFilter}
       RETURNING *`,
    )
    .get(ts, pane, ...roomArgs) as Record<string, unknown> | null;
  return row ? rowToGoal(row) : null;
}

/** Canonicalize goal identity: migrate pane-bootstrap to session-bound. */
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
}

/** Get all active goals for workers in a leader's room. */
export function getActiveWorkerGoals(
  leaderName: string,
  roomId: number,
): GoalRecord[] {
  const db = getDb();

  const leader = getAgentByRoomAndName(roomId, leaderName);
  if (!leader) return [];

  const workers = getRoomMembers(leader.room_id).filter(
    (m) => m.role === 'worker',
  );
  if (workers.length === 0) return [];

  const workerNames = workers.map((w) => w.name);
  const placeholders = workerNames.map(() => '?').join(',');

  const rows = db
    .query(
      `SELECT * FROM agent_goals
       WHERE agent_name IN (${placeholders}) AND room_id = ? AND status = 'active'`,
    )
    .all(...workerNames, roomId) as Record<string, unknown>[];

  return rows.map(rowToGoal);
}
