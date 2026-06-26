import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'bun';
import { flushPushQueueForAgent } from '../delivery/index.ts';

function logDebug(message: string): void {
  try {
    const logLine = `[${new Date().toISOString()}] ${message}\n`;
    appendFileSync('/tmp/crew-hook-debug.log', logLine, 'utf8');
  } catch {
    // ignore
  }
}

import {
  extractHookCompletionMessage,
  getRuntimeSkillPrefix,
  normalizeHookEventName,
  resolveAgentRuntime,
  resolveHookEventName,
} from '../shared/hook-runtime.ts';
import type { Agent, ToolResult } from '../shared/types.ts';
import { ok } from '../shared/types.ts';
import {
  getActiveDbPath,
  getDb,
  getDbPath,
  initDbWithRetry,
  withRetry,
} from '../state/db.ts';
import { STUCK_DEFAULTS } from '../state/goal-stuck.ts';
import type { HintRecord } from '../state/index.ts';
import {
  addHookEvent,
  canonicalizeGoalIdentity,
  canonicalizeHintIdentity,
  capturePartyResponseIfActive,
  clearArmedInputBlock,
  consumeLeaderGoalReminder,
  createLeaderDialog,
  getAgentByPane,
  getAgentBySessionId,
  getAgentInputBlockMode,
  getAllAgents,
  getGoalByAgent,
  getRoomMembers,
  isAgentAutoSelfOnIdle,
  notifyLeadersOnWorkerStop,
  pauseGoalReminder,
  recordAndEvaluateGoalStuck,
  tickGoalTurnCount,
  tickHintCadence,
} from '../state/index.ts';
import { resolveAgentByCwdFallback } from '../state/session-binding.ts';
import { sendKeys } from '../tmux/index.ts';
import {
  extractDialogFromPermission,
  formatLeaderNotice,
} from './dialog-notice.ts';

function extractString(
  payload: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

function extractSessionId(payload: Record<string, unknown>): string | null {
  return extractString(payload, [
    'session_id',
    'sessionId',
    'conversationId', // agy (Antigravity)
    'turn_id',
    'turnId',
  ]);
}

function extractCwd(payload: Record<string, unknown>): string | null {
  const cwd = extractString(payload, ['cwd']);
  if (cwd) return cwd;

  const workspacePaths = payload.workspacePaths;
  if (Array.isArray(workspacePaths) && typeof workspacePaths[0] === 'string') {
    return workspacePaths[0].trim();
  }
  return null;
}

function okResult(
  payload: Record<string, unknown> = { ok: true, decision: 'allow' },
): ToolResult {
  if (payload.decision === undefined) {
    payload.decision = 'allow';
  }
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/**
 * Build a PermissionRequest hook response that auto-allows the permission
 * and escalates the session to bypassPermissions mode (if available).
 */
function permissionAllowResult(input: Record<string, unknown>): ToolResult {
  const hookSpecificOutput = {
    hookEventName: 'PermissionRequest',
    decision: {
      behavior: 'allow',
      updatedPermissions: [
        {
          type: 'setMode',
          mode: 'bypassPermissions',
          destination: 'session',
        },
      ],
    },
  };

  const payload: Record<string, unknown> = {
    ok: true,
    hookSpecificOutput,
  };

  // Echo back permission_suggestions as updatedPermissions so each
  // individual tool rule gets persisted too
  const suggestions = input.permission_suggestions;
  if (Array.isArray(suggestions) && suggestions.length > 0) {
    hookSpecificOutput.decision.updatedPermissions = [
      ...hookSpecificOutput.decision.updatedPermissions,
      ...suggestions,
    ];
  }

  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

export async function processHookEventInput(
  input: string,
  pane: string | undefined,
  eventOverride?: string,
): Promise<ToolResult> {
  logDebug(`[hook-event] Input: ${input.trim()}, resolvedPaneId: ${pane}`);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(input);
  } catch (err) {
    logDebug(
      `[hook-event] JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Malformed JSON — silently exit
    return okResult();
  }

  const sessionId = extractSessionId(payload);
  const cwd = extractCwd(payload);

  // Use retry-aware init — concurrent hook processes all contend on the
  // same SQLite file, and schema migrations hold write locks.  The retry
  // wrapper handles SQLITE_BUSY with exponential backoff.
  const targetDbPath = getDbPath(cwd ? cwd : undefined);
  let dbInitialized = false;
  try {
    getDb();
    const activePath = getActiveDbPath();
    if (activePath === ':memory:' || activePath === targetDbPath) {
      dbInitialized = true;
    }
  } catch {
    // not initialized
  }
  if (!dbInitialized) {
    initDbWithRetry(cwd ? cwd : undefined);
  }

  const eventType = eventOverride
    ? normalizeHookEventName(eventOverride)
    : resolveHookEventName(payload);
  logDebug(
    `[hook-event] Event: ${eventType}, sessionId: ${sessionId}, cwd: ${cwd}`,
  );

  let agent =
    (pane ? getAgentByPane(pane) : undefined) ??
    (sessionId ? getAgentBySessionId(sessionId) : undefined);
  if (!agent && !pane && sessionId) {
    agent = resolveAgentByCwdFallback(cwd, eventType, getAllAgents());
  }
  if (!agent) {
    if (sessionId) {
      logDebug(
        `[hook-event] Agent not found for pane ${pane} session ${sessionId} event ${eventType}`,
      );
      console.error(
        `[crew hook-event] could not resolve agent for pane ${pane} session ${sessionId} event ${eventType}`,
      );
    } else {
      logDebug(
        `[hook-event] Agent not found and no sessionId. Pane: ${pane}, event: ${eventType}`,
      );
    }
    return okResult();
  }

  logDebug(
    `[hook-event] Agent found: ${agent.name} (role: ${agent.role}, room: ${agent.room_id})`,
  );

  if (!pane) {
    const hookEventId = withRetry(() =>
      addHookEvent(agent.name, eventType, sessionId, input, agent.room_id),
    );
    if (eventType === 'PermissionRequest') {
      // No-pane hooks are valid for Codex; keep behavior permissive and
      // still persist the event for postmortem/audit consistency.
      return permissionAllowResult(payload);
    }
    // Session-only hook events can still be used for completion/instrumentation.
    if (isStopLikeEvent(eventType)) {
      capturePartyResponseIfActive(
        agent.name,
        input,
        hookEventId,
        agent.room_id,
        sessionId,
      );
      notifyLeadersOnWorkerStop(agent.name, input, agent.room_id, sessionId);
    }
    return okResult();
  }

  // PermissionRequest: auto-allow all permission dialogs for crew agents.
  // This prevents agents from getting stuck waiting for user approval.
  if (eventType === 'PermissionRequest') {
    // Record the event for audit trail
    try {
      getDb();
    } catch {
      initDbWithRetry();
    }
    const sessionId =
      typeof payload.session_id === 'string'
        ? payload.session_id
        : typeof payload.sessionId === 'string'
          ? payload.sessionId
          : null;
    const hookEventId = withRetry(() =>
      addHookEvent(agent.name, eventType, sessionId, input, agent.room_id),
    );

    // Leader ↔ worker dialog bridge: AskUserQuestion / ExitPlanMode are genuine
    // decision points — record a pending dialog and immediately notify the
    // room's leader (immediate interrupt) so it can answer by driving the
    // worker's pane. The UI still renders (allow); the leader answers async.
    const extracted = extractDialogFromPermission(payload);
    if (extracted) {
      try {
        const leader = getRoomMembers(agent.room_id).find(
          (m) => m.role === 'leader' && m.tmux_target,
        );
        const dialog = createLeaderDialog({
          roomId: agent.room_id,
          workerName: agent.name,
          workerPane: agent.tmux_target,
          leaderName: leader?.name ?? null,
          dialogType: extracted.dialogType,
          toolName: extracted.toolName,
          sessionId,
          questions: extracted.questions,
          sourceHookEventId: hookEventId,
        });
        if (leader?.tmux_target) {
          const notice = formatLeaderNotice({
            workerName: agent.name,
            dialogType: extracted.dialogType,
            questions: extracted.questions,
          });
          // Delay so the worker UI finishes rendering before the leader is
          // interrupted; fire-and-forget (must not block the hook return).
          setTimeout(
            () =>
              sendKeys(
                leader.tmux_target!,
                `(dialog #${dialog.id}) ${notice}`,
              ).catch(() => {}),
            1500,
          );
        }
      } catch (e) {
        console.error(
          `[crew dialog] hook record error: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    return permissionAllowResult(payload);
  }

  // addHookEvent does INSERT + UPDATE + possible notification writes —
  // wrap in retry since multiple hook processes may contend on the same DB.
  const hookEventId = withRetry(() =>
    addHookEvent(agent.name, eventType, sessionId, input, agent.room_id),
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
  if (eventType === 'UserPromptSubmit' || eventType === 'PreInvocation') {
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
            type: 'text',
            text: JSON.stringify({
              ok: true,
              decision: 'allow',
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
  // Stuck-detector: if the last few outputs are a tight near-identical loop,
  // pause the reminder and send ONE explicit notice so the agent itself
  // resolves the goal (weak-LLM agents never run `crew goal done` on their own).
  if (isStopLikeEvent(eventType)) {
    try {
      const goal =
        agent.role === 'leader'
          ? consumeLeaderGoalReminder(pane, sessionId, agent.room_id)
          : tickGoalTurnCount(pane, sessionId, agent.room_id);

      if (goal && goal.status === 'active' && agent.tmux_target) {
        if (goal.reminder_paused === 1) {
          // Already tripped by stuck-detector → stay silent (no nag, no record).
        } else {
          // Record this completion output and evaluate loop-iness.
          const message = extractHookCompletionMessage(input);
          const { stuck } = recordAndEvaluateGoalStuck(
            goal.id,
            message,
            Date.now(),
          );
          // Pause only on the trip; pauseGoalReminder is a no-op if already
          // paused, so `justPaused` is true exactly once → exactly-one notice.
          const justPaused = stuck ? pauseGoalReminder(goal.id) : false;

          // Delay 1.5s so agent finishes idle transition before reminder arrives.
          // Re-check goal state before sending in case it changed while waiting.
          setTimeout(async () => {
            try {
              const skillPrefix = getRuntimeSkillPrefix(
                await resolveAgentRuntime(agent.agent_type, agent.tmux_target),
              );
              const latestGoal = getGoalByAgent(agent.name, agent.room_id);
              if (!latestGoal || latestGoal.status !== 'active') return;

              const latestDesc =
                latestGoal.description.length > 500
                  ? latestGoal.description.slice(0, 497) + '…'
                  : latestGoal.description;

              // Stuck-notice: hand the decision to the agent itself, exactly once.
              if (justPaused && latestGoal.reminder_paused === 1) {
                const notice =
                  `⚠️ Goal looks stuck (${STUCK_DEFAULTS.window} turns, near-identical output).\n` +
                  `Goal: ${latestDesc}\n` +
                  `Decide — run a bash command:\n` +
                  `✅ crew goal done            — if finished\n` +
                  `📝 crew goal update "..."    — to redirect\n` +
                  `❌ crew goal unset           — if unreachable\n` +
                  `(No more auto-reminders after this notice.)`;
                await sendKeys(agent.tmux_target!, notice).catch(() => {});
                return;
              }

              // `crew:leader`/`crew:worker` are SKILL invocations → runtime prefix ($ for codex).
              // `crew goal done`/`crew goal unset` are CLI subcommands → `!` prefix (both runtimes).
              const latestReminder = `🎯 Goal: ${latestDesc} (turn ${latestGoal.turn_count})\n✅ If done, ${
                agent.role === 'leader'
                  ? `${skillPrefix}crew:leader`
                  : `${skillPrefix}crew:worker`
              } run bash command: crew goal done\n❌ If unreachable, run bash command: crew goal unset\n📝 Edit: crew goal update "new description"`;

              await sendKeys(agent.tmux_target!, latestReminder).catch(
                () => {},
              );
            } catch {
              // fail-open: skip reminder if anything goes wrong in re-check
            }
          }, 1500);
        }
      }
    } catch (e) {
      console.error(
        `[crew goal] reminder error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return ok({
    ok: true,
    decision: 'allow',
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
      'SELECT event_type FROM hook_events WHERE agent_name = ? AND id < ? ORDER BY id DESC LIMIT 1',
    )
    .get(agentName, currentEventId) as { event_type: string } | null;

  // If previous was also terminal, leader was already idle — skip
  if (!prevEvent || isStopLikeEvent(prevEvent.event_type)) return false;

  return true;
}

function isStopLikeEvent(eventType: string): boolean {
  return eventType === 'Stop' || eventType === 'StopFailure';
}

/**
 * Build worker summary from DB status (sync, no async pane checks).
 * Used by hook-event for the lightweight dashboard.
 */
function buildWorkerSummary(
  agent: Agent,
): { idle: number; busy: number; dead: number; unknown: number } | null {
  const members = getRoomMembers(agent.room_id).filter(
    (m) => m.name !== agent.name,
  );
  if (members.length === 0) return null;
  let idle = 0;
  let busy = 0;
  let dead = 0;
  let unknown = 0;
  for (const m of members) {
    if (m.status === 'idle') idle++;
    else if (m.status === 'busy') busy++;
    else if (m.status === 'dead') dead++;
    else unknown++;
  }
  return { idle, busy, dead, unknown };
}

function getParentPid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const parts = stat.split(' ');
    const parentPid = parts[3];
    if (!parentPid) return null;
    return parseInt(parentPid, 10);
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
    const args = socket ? ['-L', socket] : [];
    const res = spawnSync([
      'tmux',
      ...args,
      'list-panes',
      '-a',
      '-F',
      '#{pane_pid} #{pane_id}',
    ]);
    if (res.success) {
      const output = res.stdout.toString().trim();
      for (const line of output.split('\n')) {
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

export async function handleHookEvent(params?: {
  event?: string;
}): Promise<ToolResult> {
  const input = await Bun.stdin.text();
  return processHookEventInput(input, resolvePaneId(), params?.event);
}
