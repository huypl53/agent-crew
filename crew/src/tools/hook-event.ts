import { readFileSync } from "node:fs";
import { spawnSync } from "bun";
import { flushPushQueueForAgent } from "../delivery/index.ts";
import type { Agent, ToolResult } from "../shared/types.ts";
import { ok } from "../shared/types.ts";
import { getDb, initDbWithRetry, withRetry } from "../state/db.ts";
import type { HintRecord } from "../state/index.ts";
import {
  addHookEvent,
  canonicalizeGoalIdentity,
  canonicalizeHintIdentity,
  clearArmedInputBlock,
  consumeLeaderGoalReminder,
  getAgentByPane,
  getAgentInputBlockMode,
  getGoalByAgent,
  getRoomMembers,
  isAgentAutoSelfOnIdle,
  tickGoalTurnCount,
  tickHintCadence,
} from "../state/index.ts";
import { sendKeys } from "../tmux/index.ts";

function okResult(
  payload: Record<string, unknown> = { ok: true, decision: "allow" },
): ToolResult {
  if (payload.decision === undefined) {
    payload.decision = "allow";
  }
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/**
 * Build a PermissionRequest hook response that auto-allows the permission
 * and escalates the session to bypassPermissions mode (if available).
 */
function permissionAllowResult(
  input: Record<string, unknown>,
): ToolResult {
  const payload: Record<string, unknown> = {
    ok: true,
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        updatedPermissions: [
          {
            type: "setMode",
            mode: "bypassPermissions",
            destination: "session",
          },
        ],
      },
    },
  };

  // Echo back permission_suggestions as updatedPermissions so each
  // individual tool rule gets persisted too
  const suggestions = input.permission_suggestions;
  if (Array.isArray(suggestions) && suggestions.length > 0) {
    const perms = payload.hookSpecificOutput.decision.updatedPermissions;
    payload.hookSpecificOutput.decision.updatedPermissions = [
      ...perms,
      ...suggestions,
    ];
  }

  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export async function processHookEventInput(
  input: string,
  pane: string | undefined,
): Promise<ToolResult> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(input);
  } catch {
    // Malformed JSON — silently exit
    return okResult();
  }

  if (!pane) {
    return okResult();
  }

  // Use retry-aware init — concurrent hook processes all contend on the
  // same SQLite file, and schema migrations hold write locks.  The retry
  // wrapper handles SQLITE_BUSY with exponential backoff.
  try {
    getDb();
  } catch {
    initDbWithRetry();
  }

  const agent = getAgentByPane(pane);
  if (!agent) {
    return okResult();
  }

  // PermissionRequest: auto-allow all permission dialogs for crew agents.
  // This prevents agents from getting stuck waiting for user approval.
  const eventType = String(
    payload.hook_event_name ?? payload.event ?? payload.eventName ?? "Unknown",
  );

  if (eventType === "PermissionRequest") {
    // Record the event for audit trail
    try {
      getDb();
    } catch {
      initDbWithRetry();
    }
    const sessionId =
      typeof payload.session_id === "string"
        ? payload.session_id
        : typeof payload.sessionId === "string"
          ? payload.sessionId
          : null;
    withRetry(() =>
      addHookEvent(
        agent.name,
        eventType,
        sessionId,
        input,
        agent.room_id,
      ),
    );
    return permissionAllowResult(payload);
  }

  const sessionId =
    typeof payload.session_id === "string"
      ? payload.session_id
      : typeof payload.sessionId === "string"
        ? payload.sessionId
        : null;

  // addHookEvent does INSERT + UPDATE + possible notification writes —
  // wrap in retry since multiple hook processes may contend on the same DB.
  const hookEventId = withRetry(() =>
    addHookEvent(
      agent.name,
      eventType,
      sessionId,
      input,
      agent.room_id,
    ),
  );

  // Canonicalize hint identity when session_id is first available
  if (sessionId) {
    try {
      canonicalizeHintIdentity(agent.name, pane, sessionId);
    } catch (e) {
      // Fail-open: don't block hook processing on canonicalization errors
      console.error(
        `[crew hint] canonicalize error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      canonicalizeGoalIdentity(agent.name, pane, sessionId);
    } catch (e) {
      console.error(
        `[crew goal] canonicalize error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Hint injection: on every Nth UserPromptSubmit (where N = cadence),
  // emit the user-defined message to stdout. Claude Code injects hook
  // stdout into the conversation, providing custom context reminders.
  if (eventType === "UserPromptSubmit") {
    const wasBlocked = clearArmedInputBlock(agent.name);

    // Flush pending push messages that accumulated while blocked
    if (wasBlocked && agent.tmux_target) {
      flushPushQueueForAgent(agent).catch((e) => {
        console.error(
          `[crew block] flush after unblock failed for ${agent.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }

    // Cadence-gated hint injection for model context
    let cadenceResult: { shouldShow: boolean; hint: HintRecord | null } | null =
      null;
    try {
      cadenceResult = tickHintCadence(pane, sessionId, agent.room_id);
    } catch (e) {
      // Fail-open: never block hook processing on hint errors
      console.error(
        `[crew hint] cadence error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (cadenceResult?.shouldShow && cadenceResult.hint) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              decision: "allow",
              hint: {
                agent_name: cadenceResult.hint.agent_name,
                message: cadenceResult.hint.message,
              },
            }),
          },
        ],
      };
    }
  }

  // Status dashboard: on Stop event for leaders with auto-self enabled,
  // emit a lightweight dashboard to stderr (non-blocking notice in chat UI).
  // Replaces the old pane-queue injection that could break user input.
  let statusDashboard: string | undefined;

  // if (eventType === 'Stop' && agent.role === 'leader') {
  //   try {
  //     const shouldShowDashboard = checkAutoSelfTransition(
  //       agent.name,
  //       hookEventId,
  //     );
  //     if (shouldShowDashboard) {
  //       statusDashboard = formatInline({
  //         name: agent.name,
  //         role: agent.role,
  //         room: agent.room_name,
  //         status: 'idle',
  //         tmux_target: agent.tmux_target,
  //         input_block_mode: getAgentInputBlockMode(agent.name),
  //         hint: null,
  //         pending_messages: getPendingMessageCount(agent.name, agent.agent_id),
  //         workers: buildWorkerSummary(agent),
  //         last_activity_ago: null, // skip async lookup in hook context
  //       });
  //     }
  //   } catch (e) {
  //     // Fail-open: don't block hook processing on dashboard errors
  //     console.error(
  //       `[crew status] dashboard error: ${e instanceof Error ? e.message : String(e)}`,
  //     );
  //   }
  // }

  // Goal reminder: workers remind on every Stop; leaders remind only after
  // the queue has drained and a prior crew delivery armed the reminder state.
  if (eventType === "Stop") {
    try {
      const goal =
        agent.role === 'leader'
          ? consumeLeaderGoalReminder(pane, sessionId, agent.room_id)
          : tickGoalTurnCount(pane, sessionId, agent.room_id);
      if (goal && goal.status === "active" && agent.tmux_target) {
        const desc =
          goal.description.length > 100
            ? goal.description.slice(0, 97) + "…"
            : goal.description;
        const reminder = `🎯 Goal: ${desc} (turn ${goal.turn_count})\n✅ If done, run: crew goal done\n❌ If unreachable, run: crew goal unset\n📝 Edit: crew goal update "new description"`;
        // Delay 1.5s so agent finishes idle transition before reminder arrives
        setTimeout(() => sendKeys(agent.tmux_target!, reminder).catch(() => {}), 1500);
      }
    } catch (e) {
      console.error(
        `[crew goal] reminder error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return ok({
    ok: true,
    decision: "allow",
    ...(statusDashboard ? { statusDashboard } : {}),
  });
}

/**
 * Check if auto-self dashboard should be shown:
 * leader with auto-self enabled, transitioning busy→idle.
 */
function checkAutoSelfTransition(
  agentName: string,
  currentEventId: number,
): boolean {
  if (!isAgentAutoSelfOnIdle(agentName)) return false;

  // Check previous event: only trigger on genuine busy→idle transition
  const db = getDb();
  const prevEvent = db
    .query(
      "SELECT event_type FROM hook_events WHERE agent_name = ? AND id < ? ORDER BY id DESC LIMIT 1",
    )
    .get(agentName, currentEventId) as { event_type: string } | null;

  // If previous was also a Stop, leader was already idle — skip
  if (!prevEvent || prevEvent.event_type === "Stop") return false;

  return true;
}

/**
 * Build worker summary from DB status (sync, no async pane checks).
 * Used by hook-event for the lightweight dashboard.
 */
function buildWorkerSummary(
  agent: Agent,
): { idle: number; busy: number; dead: number } | null {
  const members = getRoomMembers(agent.room_id).filter(
    (m) => m.name !== agent.name,
  );
  if (members.length === 0) return null;
  let idle = 0;
  let busy = 0;
  let dead = 0;
  for (const m of members) {
    if (m.status === "idle") idle++;
    else if (m.status === "busy") busy++;
    else dead++;
  }
  return { idle, busy, dead };
}

function getParentPid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const parts = stat.split(" ");
    return parseInt(parts[3], 10);
  } catch {
    return null;
  }
}

function getAncestry(pid: number): number[] {
  const list: number[] = [];
  let current: number | null = pid;
  while (current && current > 1) {
    list.push(current);
    current = getParentPid(current);
  }
  return list;
}

function getTmuxPanes(): Map<number, string> {
  const map = new Map<number, string>();
  try {
    const socket = process.env.CREW_TMUX_SOCKET;
    const args = socket ? ["-L", socket] : [];
    const res = spawnSync([
      "tmux",
      ...args,
      "list-panes",
      "-a",
      "-F",
      "#{pane_pid} #{pane_id}",
    ]);
    if (res.success) {
      const output = res.stdout.toString().trim();
      for (const line of output.split("\n")) {
        const [pidStr, paneId] = line.trim().split(/\s+/);
        if (pidStr && paneId) {
          const pid = parseInt(pidStr, 10);
          if (Number.isInteger(pid)) {
            map.set(pid, paneId);
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return map;
}

export function resolvePaneId(): string | undefined {
  if (process.env.TMUX_PANE) {
    return process.env.TMUX_PANE;
  }
  const panes = getTmuxPanes();
  if (panes.size === 0) return undefined;

  const ancestry = getAncestry(process.pid);
  for (const pid of ancestry) {
    const paneId = panes.get(pid);
    if (paneId) {
      return paneId;
    }
  }
  return undefined;
}

export async function handleHookEvent(_params?: unknown): Promise<ToolResult> {
  const input = await Bun.stdin.text();
  return processHookEventInput(input, resolvePaneId());
}
