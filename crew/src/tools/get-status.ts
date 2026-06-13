import { getPaneStatus } from "../shared/pane-status.ts";
import { logServer } from "../shared/server-log.ts";
import type { Agent, AgentStatus, ToolResult } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";
import { getDb, initDb } from "../state/db.ts";
import {
  getAgent,
  getAgentByPane,
  getAgentBySessionId,
  getAgentInputBlockMode,
  getAgentMessageCounts,
  getGoalByAgent,
  getHint,
  getLatestHookEvent,
  getRoomMembers,
  touchAgentActivity,
} from "../state/index.ts";
import { getContextWindowForPane } from "../tokens/claude-code.ts";
import type { ContextWindowInfo } from "../tokens/claude-code.ts";
import { isPaneDead } from "../tmux/index.ts";

interface GetStatusParams {
  agent_name?: string;
  name?: string; // calling agent's own identity
  self?: boolean; // auto-detect agent from TMUX_PANE, show dashboard
  inline?: boolean; // compact inline bar (with --self)
  json?: boolean; // structured JSON output (with --self)
  session?: string; // Query agent by session ID
}

// --- Dashboard formatting (--self mode) ---

export interface WorkerSummary {
  idle: number;
  busy: number;
  dead: number;
  unknown: number;
}

export function countWorkerStatuses(
  results: PromiseSettledResult<AgentStatus>[],
): WorkerSummary {
  let idle = 0, busy = 0, dead = 0, unknown = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value === 'idle') idle++;
      else if (r.value === 'busy') busy++;
      else if (r.value === 'dead') dead++;
      else unknown++;
    }
  }
  return { idle, busy, dead, unknown };
}

export interface DashboardData {
  name: string;
  role: string;
  room: string;
  status: string;
  tmux_target: string | null;
  input_block_mode: string;
  hint: { message: string; cadence: number } | null;
  goal: { description: string; status: string; turn_count: number } | null;
  pending_messages: number;
  workers: WorkerSummary | null;
  last_activity_ago: string | null;
  context_window?: ContextWindowInfo | null;
  // --json only
  typing_active?: boolean;
  session_id?: string | null;
  agent_type?: string;
  message_counts?: { sent: number; received: number };
}

export function getPendingMessageCount(
  agentName: string,
  agentId: number,
): number {
  try {
    const db = getDb();
    // Use the higher of pull cursor and push cursor — agents may consume via either mode
    const pullRow = db
      .query("SELECT last_seq FROM cursors WHERE agent_id = ?")
      .get(agentId) as { last_seq: number } | null;
    const pushRow = db
      .query("SELECT last_seq FROM push_cursors WHERE agent_id = ?")
      .get(agentId) as { last_seq: number } | null;
    const cursor = Math.max(pullRow?.last_seq ?? 0, pushRow?.last_seq ?? 0);
    const row = db
      .query(
        "SELECT COUNT(*) as cnt FROM messages WHERE recipient = ? AND id > ?",
      )
      .get(agentName, cursor) as { cnt: number } | null;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

export function getLastActivity(agentName: string): string | null {
  try {
    const db = getDb();
    const row = db
      .query(
        "SELECT last_activity FROM agents WHERE name = ? ORDER BY id DESC LIMIT 1",
      )
      .get(agentName) as { last_activity: string | null } | null;
    return row?.last_activity ?? null;
  } catch {
    return null;
  }
}

export function formatAgo(isoString: string | null): string | null {
  if (!isoString) return null;
  try {
    // Normalize to parseable ISO 8601.
    // Sources: SQLite datetime() → "YYYY-MM-DD HH:MM:SS" (space, no TZ)
    //          JS toISOString()  → "YYYY-MM-DDTHH:MM:SS.sssZ" (already valid)
    let normalized = isoString.replace(" ", "T"); // SQLite → ISO separator
    if (!normalized.endsWith("Z") && !normalized.includes("+")) {
      normalized += "Z"; // Add UTC suffix if missing
    }
    const ms = Date.now() - new Date(normalized).getTime();
    if (ms < 1000) return "just now";
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    return `${Math.floor(ms / 3_600_000)}h ago`;
  } catch {
    return null;
  }
}

export function formatDashboard(data: DashboardData): string {
  const W = 42; // inner width (excluding │...│)
  const lines: string[] = [];

  const header = `${data.name} @ ${data.room}${data.tmux_target ? ` pane:${data.tmux_target}` : ""}`;
  lines.push(`┌─ ${header} ${"─".repeat(Math.max(1, W - header.length - 1))}┐`);

  const statusBlock = `Status: ${data.status} │ Block: ${data.input_block_mode}`;
  lines.push(`│ ${statusBlock.padEnd(W)}│`);

  if (data.hint) {
    const hintLine = `Hint: ${data.hint.message} (every ${data.hint.cadence}t)`;
    lines.push(`│ ${hintLine.padEnd(W)}│`);
  }

  if (data.goal && data.goal.status === 'active') {
    const maxDescLen = W - 16; // "Goal: ... (NNNt)" overhead
    const desc = data.goal.description.length > maxDescLen
      ? data.goal.description.slice(0, maxDescLen - 1) + '…'
      : data.goal.description;
    const goalLine = `Goal: ${desc} (${data.goal.turn_count}t)`;
    lines.push(`│ ${goalLine.padEnd(W)}│`);
  }

  const pendingLine = `Pending: ${data.pending_messages} msgs`;
  lines.push(`│ ${pendingLine.padEnd(W)}│`);

  if (data.context_window) {
    const cw = data.context_window;
    const ctxLine = `Ctx: ${cw.context_used.toLocaleString()} / ${cw.context_limit.toLocaleString()} (${cw.context_pct}%)`;
    lines.push(`│ ${ctxLine.padEnd(W)}│`);
  }

  if (data.workers) {
    const w = data.workers;
    const workerLine = `Workers: ${w.idle} idle · ${w.busy} busy · ${w.dead} dead · ${w.unknown} unknown`;
    lines.push(`│ ${workerLine.padEnd(W)}│`);
  }

  if (data.last_activity_ago !== null) {
    const actLine = `Last activity: ${data.last_activity_ago}`;
    lines.push(`│ ${actLine.padEnd(W)}│`);
  }

  lines.push(`└${"─".repeat(W + 2)}┘`);
  return lines.join("\n");
}

// --- Inline status bar (--self --inline) ---
// Same compact format emitted by the Stop hook via buildLightweightDashboard.

export function formatInline(data: DashboardData): string {
  const parts: string[] = [];

  let paneStatus = "⬡ pane:";
  if (data.tmux_target) {
    paneStatus += `${data.tmux_target}`;
  }
  parts.push(paneStatus);

  let blockPart = `⬣ block:${data.input_block_mode || "None"}`;
  if (data.pending_messages > 0) {
    blockPart += ` (${data.pending_messages}q)`;
  }
  parts.push(blockPart);

  let hintMsg = "💡 hint:";
  if (data.hint) {
    const truncated =
      data.hint.message.length > 40
        ? data.hint.message.slice(0, 37) + "…"
        : data.hint.message;
    hintMsg += `"${truncated}"`;
  } else {
    hintMsg += "(No hint)";
  }

  if (data.workers) {
    const w = data.workers;
    parts.push(`\u{1F465} ${w.idle}i·${w.busy}b·${w.dead}d·${w.unknown}u`);
  }

  if (data.goal && data.goal.status === 'active') {
    const truncated =
      data.goal.description.length > 30
        ? data.goal.description.slice(0, 27) + '…'
        : data.goal.description;
    parts.push(`🎯 "${truncated}"`);
  }

  return parts.join(' ');
}

// --- Core status resolver (unchanged) ---

export async function resolveAgentLiveStatus(
  agent: Agent,
): Promise<AgentStatus> {
  const dead = await isPaneDead(agent.tmux_target);
  if (dead) {
    return "dead";
  }

  try {
    let result = await getPaneStatus(agent.tmux_target);
    if (result.status === "unknown") {
      await Bun.sleep(3500);
      result = await getPaneStatus(agent.tmux_target);
    }
    if (result.contentChanged) {
      touchAgentActivity(agent.name);
    }
    return result.status;
  } catch (e) {
    logServer(
      "ERROR",
      `getPaneStatus failed for ${agent.name} (pane ${agent.tmux_target}): ${e instanceof Error ? e.message : String(e)}`,
    );
    return "unknown";
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
      return err("Missing required param: agent_name, name, or session");
    }

    agent = getAgent(targetName);
    if (!agent) {
      return err(`Agent "${targetName}" is not registered`);
    }
  }

  const status = await resolveAgentLiveStatus(agent);

  // --inline without --self: compact bar for a named agent
  if (params.inline) {
    const inputBlockMode = getAgentInputBlockMode(agent.name);
    const pendingMessages = getPendingMessageCount(agent.name, agent.agent_id);
    const lastActivityAgo = formatAgo(getLastActivity(agent.name));

    let workers: WorkerSummary | null = null;
    if (agent.role === "leader") {
      const members = getRoomMembers(agent.room_id).filter(
        (m) => m.name !== agent.name,
      );
      const statusResults = await Promise.allSettled(
        members.map((m) => resolveAgentLiveStatus(m)),
      );
      workers = countWorkerStatuses(statusResults);
    }

    // Context window: read from JSONL on-demand
    let contextWindow: ContextWindowInfo | null = null;
    if (agent.tmux_target) {
      try {
        contextWindow = await getContextWindowForPane(agent.tmux_target);
      } catch {
        // fail-open
      }
    }

    const data: DashboardData = {
      name: agent.name,
      role: agent.role,
      room: agent.room_name,
      status,
      tmux_target: agent.tmux_target,
      input_block_mode: inputBlockMode,
      hint: null,
      goal: null,
      pending_messages: pendingMessages,
      workers,
      last_activity_ago: lastActivityAgo,
      context_window: contextWindow,
    };

    return ok({ inline: formatInline(data) });
  }

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
        "No registered agent found for current pane. Pass --name explicitly.",
      );
  } else {
    return err("Not running inside a tmux pane. Pass --name explicitly.");
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
  let workers: WorkerSummary | null = null;
  if (agent.role === "leader") {
    const members = getRoomMembers(agent.room_id).filter(
      (m) => m.name !== agent?.name,
    );
    const statusResults = await Promise.allSettled(
      members.map((m) => resolveAgentLiveStatus(m)),
    );
    workers = countWorkerStatuses(statusResults);
  }

  // Last activity
  const lastActivityAgo = formatAgo(getLastActivity(agent.name));

  // Goal: lookup active goal for this agent
  let goalData: { description: string; status: string; turn_count: number } | null = null;
  try {
    const goal = getGoalByAgent(agent.name, agent.room_id);
    if (goal && goal.status === 'active') {
      goalData = { description: goal.description, status: goal.status, turn_count: goal.turn_count };
    }
  } catch {
    // fail-open
  }

  // Context window: read from JSONL on-demand
  let contextWindow: ContextWindowInfo | null = null;
  if (agent.tmux_target) {
    try {
      contextWindow = await getContextWindowForPane(agent.tmux_target);
    } catch {
      // fail-open — don't block status display
    }
  }

  const data: DashboardData = {
    name: agent.name,
    role: agent.role,
    room: agent.room_name,
    status,
    tmux_target: agent.tmux_target,
    input_block_mode: inputBlockMode,
    hint: hintData,
    goal: goalData,
    pending_messages: pendingMessages,
    workers,
    last_activity_ago: lastActivityAgo,
    context_window: contextWindow,
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

  if (params.inline) {
    return ok({ inline: formatInline(data) });
  }

  return ok({ dashboard: formatDashboard(data) });
}
