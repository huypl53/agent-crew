import type { ActiveEndpoint, Agent } from '../shared/types.ts';
import { getDb } from './db.ts';

export interface SessionBindingRecord {
  room_id: number;
  agent_name: string;
  pane: string | null;
  last_seen_at: string;
}

function normalizePathForMatch(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

export function isPathMatchCandidate(roomPath: string, cwd: string): boolean {
  const normalizedRoomPath = normalizePathForMatch(roomPath);
  const normalizedCwd = normalizePathForMatch(cwd);
  if (!normalizedRoomPath || !normalizedCwd) return false;
  return (
    normalizedCwd === normalizedRoomPath ||
    normalizedCwd.startsWith(`${normalizedRoomPath}/`)
  );
}

export function resolveAgentByCwdFallback(
  cwd: string | null,
  eventType: string | null,
  agents: Agent[],
): Agent | undefined {
  if (!cwd) return undefined;

  const candidates = agents.filter((agent) => {
    if (!agent.tmux_target || !agent.room_path) return false;
    return isPathMatchCandidate(agent.room_path, cwd);
  });
  if (candidates.length === 1) return candidates[0];

  if (
    eventType === 'Stop' ||
    eventType === 'StopFailure' ||
    eventType === 'UserPromptSubmit'
  ) {
    const workerCandidates = candidates.filter((agent) => agent.role === 'worker');
    if (workerCandidates.length === 1) return workerCandidates[0];
  }

  return undefined;
}

export function resolveActiveEndpoint(agent: Agent): ActiveEndpoint | null {
  if (!agent.tmux_target) return null;
  return {
    transport: 'tmux',
    target: agent.tmux_target,
    stale: agent.status === 'dead',
    lastSeenAt: null,
  };
}

export function bindEndpoint(agent: Agent, endpoint: ActiveEndpoint): void {
  if (endpoint.transport !== 'tmux') return;
  const db = getDb();
  db.run('UPDATE agents SET pane = NULL WHERE pane = ? AND id != ?', [
    endpoint.target,
    agent.agent_id,
  ]);
  db.run('UPDATE agents SET pane = ?, last_activity = ? WHERE id = ?', [
    endpoint.target,
    new Date().toISOString(),
    agent.agent_id,
  ]);
}

export function markEndpointStale(agent: Agent): void {
  if (!agent.tmux_target) return;
  getDb().run(
    "UPDATE agents SET pane = NULL, status = 'unknown' WHERE id = ? AND pane = ?",
    [agent.agent_id, agent.tmux_target],
  );
}

export function getSessionBindingRecord(
  sessionId: string,
): SessionBindingRecord | null {
  return getDb()
    .query(
      'SELECT room_id, agent_name, pane, last_seen_at FROM agent_session_bindings WHERE session_id = ? ORDER BY last_seen_at DESC LIMIT 1',
    )
    .get(sessionId) as SessionBindingRecord | null;
}

export function getLatestHookAgentNameBySessionId(sessionId: string): string | null {
  const row = getDb()
    .query(
      'SELECT agent_name FROM hook_events WHERE session_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(sessionId) as { agent_name: string } | null;
  return row?.agent_name ?? null;
}

export function upsertAgentSessionBinding(
  sessionId: string,
  roomId: number,
  agentName: string,
  pane?: string | null,
): void {
  getDb().run(
    `INSERT INTO agent_session_bindings (session_id, room_id, agent_name, pane, last_seen_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(session_id, room_id) DO UPDATE SET
       agent_name = excluded.agent_name,
       pane = COALESCE(excluded.pane, agent_session_bindings.pane),
       last_seen_at = datetime('now')`,
    [sessionId, roomId, agentName, pane ?? null],
  );
}
