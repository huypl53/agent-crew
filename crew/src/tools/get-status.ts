import { getPaneStatus } from '../shared/pane-status.ts';
import { logServer } from '../shared/server-log.ts';
import type { Agent, AgentStatus, ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getDb, initDb } from '../state/db.ts';
import {
  getAgent,
  getAgentByPane,
  getAgentBySessionId,
  getAgentInputBlockMode,
  getAgentMessageCounts,
  getHint,
  getLatestHookEvent,
  getRoomMembers,
  touchAgentActivity,
} from '../state/index.ts';
import { isPaneDead } from '../tmux/index.ts';

interface GetStatusParams {
  agent_name?: string;
  name?: string; // calling agent's own identity
  self?: boolean; // auto-detect agent from TMUX_PANE, show dashboard
  json?: boolean; // structured JSON output (with --self)
  session?: string; // Query agent by session ID
}

// --- Dashboard formatting (--self mode) ---

interface DashboardData {
  name: string;
  role: string;
  room: string;
  status: string;
  input_block_mode: string;
  hint: { message: string; cadence: number } | null;
  pending_messages: number;
  workers: { idle: number; busy: number; dead: number } | null;
  last_activity_ago: string | null;
  // --json only
  typing_active?: boolean;
  session_id?: string | null;
  agent_type?: string;
  message_counts?: { sent: number; received: number };
}

function getPendingMessageCount(agentName: string, agentId: number): number {
  try {
    const db = getDb();
    const cursorRow = db
      .query('SELECT last_seq FROM cursors WHERE agent_id = ?')
      .get(agentId) as { last_seq: number } | null;
    const cursor = cursorRow?.last_seq ?? 0;
    const row = db
      .query(
        'SELECT COUNT(*) as cnt FROM messages WHERE recipient = ? AND id > ?',
      )
      .get(agentName, cursor) as { cnt: number } | null;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

function getLastActivity(agentName: string): string | null {
  try {
    const db = getDb();
    const row = db
      .query(
        'SELECT last_activity FROM agents WHERE name = ? ORDER BY id DESC LIMIT 1',
      )
      .get(agentName) as { last_activity: string | null } | null;
    return row?.last_activity ?? null;
  } catch {
    return null;
  }
}

function formatAgo(isoString: string | null): string | null {
  if (!isoString) return null;
  try {
    const ms = Date.now() - new Date(`${isoString}Z`).getTime();
    if (ms < 1000) return 'just now';
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    return `${Math.floor(ms / 3_600_000)}h ago`;
  } catch {
    return null;
  }
}

function formatDashboard(data: DashboardData): string {
  const W = 42; // inner width (excluding │...│)
  const lines: string[] = [];

  const header = `${data.name} @ ${data.room}`;
  lines.push(`┌─ ${header} ${'─'.repeat(Math.max(1, W - header.length - 1))}┐`);

  const statusBlock = `Status: ${data.status} │ Block: ${data.input_block_mode}`;
  lines.push(`│ ${statusBlock.padEnd(W)}│`);

  if (data.hint) {
    const hintLine = `Hint: ${data.hint.message} (every ${data.hint.cadence}t)`;
    lines.push(`│ ${hintLine.padEnd(W)}│`);
  }

  const pendingLine = `Pending: ${data.pending_messages} msgs`;
  lines.push(`│ ${pendingLine.padEnd(W)}│`);

  if (data.workers) {
    const w = data.workers;
    const workerLine = `Workers: ${w.idle} idle · ${w.busy} busy · ${w.dead} dead`;
    lines.push(`│ ${workerLine.padEnd(W)}│`);
  }

  if (data.last_activity_ago !== null) {
    const actLine = `Last activity: ${data.last_activity_ago}`;
    lines.push(`│ ${actLine.padEnd(W)}│`);
  }

  lines.push(`└${'─'.repeat(W + 2)}┘`);
  return lines.join('\n');
}

// --- Core status resolver (unchanged) ---

export async function resolveAgentLiveStatus(
  agent: Agent,
): Promise<AgentStatus> {
  const dead = await isPaneDead(agent.tmux_target);
  if (dead) {
    return 'dead';
  }

  try {
    let result = await getPaneStatus(agent.tmux_target);
    if (result.status === 'unknown') {
      await Bun.sleep(3500);
      result = await getPaneStatus(agent.tmux_target);
    }
    if (result.contentChanged) {
      touchAgentActivity(agent.name);
    }
    return result.status;
  } catch (e) {
    logServer(
      'ERROR',
      `getPaneStatus failed for ${agent.name} (pane ${agent.tmux_target}): ${e instanceof Error ? e.message : String(e)}`,
    );
    return 'unknown';
  }
}

// --- Handler ---

export async function handleGetStatus(
  params: GetStatusParams,
): Promise<ToolResult> {
  // --self mode: auto-detect agent from TMUX_PANE, show rich dashboard
  if (params.self) {
    return handleSelfStatus(params);
  }

  let agent: Agent | undefined;

  if (params.session) {
    agent = getAgentBySessionId(params.session);
    if (!agent) {
      return err(
        `No registered agent found for session ID "${params.session}"`,
      );
    }
  } else {
    // Original behavior: query a specific agent by name
    const targetName = params.agent_name ?? params.name;

    if (!targetName) {
      return err('Missing required param: agent_name, name, or session');
    }

    agent = getAgent(targetName);
    if (!agent) {
      return err(`Agent "${targetName}" is not registered`);
    }
  }

  const status = await resolveAgentLiveStatus(agent);

  return ok({
    agent_id: agent.agent_id,
    name: agent.name,
    role: agent.role,
    room: agent.room_name,
    room_path: agent.room_path,
    status,
    tmux_target: agent.tmux_target,
    last_activity_ts: null,
  });
}

/** --self mode: dashboard for the current agent. */
async function handleSelfStatus(params: GetStatusParams): Promise<ToolResult> {
  const explicitName = params.name?.trim();
  const pane = process.env.TMUX_PANE ?? null;

  let agent: Agent | undefined;
  if (explicitName) {
    agent = getAgent(explicitName);
    if (!agent) return err(`Agent "${explicitName}" is not registered`);
  } else if (pane) {
    agent = getAgentByPane(pane);
    if (!agent)
      return err(
        'No registered agent found for current pane. Pass --name explicitly.',
      );
  } else {
    return err('Not running inside a tmux pane. Pass --name explicitly.');
  }

  initDb();

  const status = await resolveAgentLiveStatus(agent);
  const inputBlockMode = getAgentInputBlockMode(agent.name);

  // Hint: try session_id first, fall back to pane-only lookup
  let hintData: { message: string; cadence: number } | null = null;
  const latestEvent = getLatestHookEvent(agent.name);
  let hint = getHint(
    agent.tmux_target ?? null,
    latestEvent?.session_id ?? null,
    agent.room_id,
  );
  // If session_id didn't match any hint, try pane-only (no session filter)
  if (!hint && latestEvent?.session_id) {
    hint = getHint(agent.tmux_target ?? null, null, agent.room_id);
  }
  if (hint) {
    hintData = { message: hint.message, cadence: hint.cadence };
  }

  // Pending messages
  const pendingMessages = getPendingMessageCount(agent.name, agent.agent_id);

  // Worker summary (leaders only)
  let workers: { idle: number; busy: number; dead: number } | null = null;
  if (agent.role === 'leader') {
    const members = getRoomMembers(agent.room_id).filter(
      (m) => m.name !== agent?.name,
    );
    const statusResults = await Promise.allSettled(
      members.map((m) => resolveAgentLiveStatus(m)),
    );
    let idle = 0;
    let busy = 0;
    let dead = 0;
    for (const r of statusResults) {
      if (r.status === 'fulfilled') {
        if (r.value === 'idle') idle++;
        else if (r.value === 'busy') busy++;
        else if (r.value === 'dead') dead++;
      }
    }
    workers = { idle, busy, dead };
  }

  // Last activity
  const lastActivityAgo = formatAgo(getLastActivity(agent.name));

  const data: DashboardData = {
    name: agent.name,
    role: agent.role,
    room: agent.room_name,
    status,
    input_block_mode: inputBlockMode,
    hint: hintData,
    pending_messages: pendingMessages,
    workers,
    last_activity_ago: lastActivityAgo,
  };

  // Extended fields for --json
  if (params.json) {
    let typingActive = false;
    if (agent.tmux_target) {
      try {
        const paneResult = await getPaneStatus(agent.tmux_target);
        typingActive = paneResult.typingActive;
      } catch {
        // ignore
      }
    }
    data.typing_active = typingActive;
    data.session_id = latestEvent?.session_id ?? null;
    data.agent_type = agent.agent_type;
    data.message_counts = getAgentMessageCounts(agent.name);
  }

  if (params.json) {
    return ok(data as Record<string, unknown>);
  }

  return ok({ dashboard: formatDashboard(data) });
}
