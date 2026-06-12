import { initDb } from '../state/db.ts';
import {
  completeGoal,
  getAgentByPane,
  getAgentByRoomAndName,
  getGoal,
  getGoalByAgent,
  getRoom,
  setGoal,
  unsetGoal,
  updateGoalDescription,
} from '../state/index.ts';
import type { Agent, ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';

type GoalTarget =
  | { agentName: string; roomName: string; roomId: number; agent: Agent; pane: string | null }
  | { error: string };

/** Resolve target agent/room for goal operations. Auto-detects from TMUX_PANE. */
function resolveGoalTarget(params: { agent?: string; room?: string }): GoalTarget & { callerName?: string } {
  const explicitAgentName = params.agent;
  const explicitRoomName = params.room;
  const pane = process.env.TMUX_PANE ?? null;
  const paneAgent = pane ? getAgentByPane(pane) : undefined;

  if (explicitAgentName && explicitRoomName) {
    const room = getRoom(explicitRoomName);
    if (!room) return { error: `Room not found: ${explicitRoomName}` };
    const agent = getAgentByRoomAndName(room.id, explicitAgentName);
    if (!agent) return { error: `Agent ${explicitAgentName} is not in room ${explicitRoomName}` };
    return { agentName: explicitAgentName, roomName: explicitRoomName, roomId: room.id, agent, pane, callerName: paneAgent?.name };
  }

  if (paneAgent) {
    if (explicitAgentName && explicitAgentName !== paneAgent.name) {
      return {
        error: `Current pane is registered as ${paneAgent.name} in room ${paneAgent.room_name}. Omit --agent or target that agent explicitly.`,
      };
    }
    if (explicitRoomName && explicitRoomName !== paneAgent.room_name) {
      return {
        error: `Current pane is registered in room ${paneAgent.room_name}. Omit --room or target that room explicitly.`,
      };
    }
    return {
      agentName: paneAgent.name,
      roomName: paneAgent.room_name,
      roomId: paneAgent.room_id,
      agent: paneAgent,
      pane: paneAgent.tmux_target,
      callerName: paneAgent.name,
    };
  }

  if (!explicitAgentName || !explicitRoomName) {
    return {
      error:
        'No registered agent found for current pane. Run from a registered agent pane or pass both --agent and --room explicitly.',
    };
  }

  return {
    error: 'No registered agent found for current pane. Run from a registered agent pane or pass both --agent and --room explicitly.',
  };
}

/** Set a goal for an agent. Usage: crew goal set "description" [--agent X --room Y] */
export async function handleGoalSet(params: {
  agent?: string;
  room?: string;
  message?: string;
}): Promise<ToolResult> {
  initDb();

  if (!params.message?.trim()) {
    return err('Message is required. Example: crew goal set "Implement auth module"');
  }

  const target = resolveGoalTarget(params);
  if ('error' in target) return err(target.error);

  // If caller differs from target agent, setBy = caller name; otherwise 'self'
  const setBy = target.callerName && target.callerName !== target.agentName
    ? target.callerName
    : 'self';

  const goal = setGoal(target.agentName, target.roomId, params.message.trim(), {
    pane: target.agent.tmux_target ?? target.pane ?? undefined,
    setBy,
  });

  return ok({
    ok: true,
    goal: {
      agent_name: goal.agent_name,
      room_name: target.roomName,
      description: goal.description,
      status: goal.status,
      turn_count: goal.turn_count,
    },
  });
}

/** Mark goal as done. Usage: crew goal done [--agent X --room Y] */
export async function handleGoalDone(params: {
  agent?: string;
  room?: string;
}): Promise<ToolResult> {
  initDb();

  const target = resolveGoalTarget(params);
  if ('error' in target) return err(target.error);

  const done = completeGoal(target.agentName, target.roomId);
  if (!done) return err(`No active goal found for ${target.agentName} in ${target.roomName}`);

  return ok({
    ok: true,
    goal_status: 'done',
    message: `Goal completed for ${target.agentName} in ${target.roomName}`,
  });
}

/** Update goal description. Usage: crew goal update "new desc" [--agent X --room Y] */
export async function handleGoalUpdate(params: {
  agent?: string;
  room?: string;
  message?: string;
}): Promise<ToolResult> {
  initDb();

  if (!params.message?.trim()) {
    return err('Message is required. Example: crew goal update "New description"');
  }

  const target = resolveGoalTarget(params);
  if ('error' in target) return err(target.error);

  const updated = updateGoalDescription(target.agentName, target.roomId, params.message.trim());
  if (!updated) return err(`No active goal found for ${target.agentName} in ${target.roomName}`);

  return ok({
    ok: true,
    goal: { description: params.message.trim() },
    message: `Goal updated for ${target.agentName} in ${target.roomName}`,
  });
}

/** Unset (remove) goal. Usage: crew goal unset [--agent X --room Y] */
export async function handleGoalUnset(params: {
  agent?: string;
  room?: string;
}): Promise<ToolResult> {
  initDb();

  const target = resolveGoalTarget(params);
  if ('error' in target) return err(target.error);

  const removed = unsetGoal(target.agentName, target.roomId);
  if (!removed) return err(`No goal found for ${target.agentName} in ${target.roomName}`);

  return ok({
    ok: true,
    removed: true,
    message: `Goal removed for ${target.agentName} in ${target.roomName}`,
  });
}

/** Lookup current goal. Usage: crew goal lookup [--session ID --pane P] [--agent X --room Y] */
export async function handleGoalLookup(params: {
  agent?: string;
  room?: string;
  session?: string;
  pane?: string;
}): Promise<ToolResult> {
  initDb();

  const sessionId = params.session ?? null;
  const pane = params.pane ?? null;

  // Explicit session/pane lookup (hook context)
  if (sessionId || pane) {
    const goal = getGoal(pane, sessionId);
    return ok({ ok: true, goal: goal ?? null });
  }

  // Agent-based lookup
  const target = resolveGoalTarget(params);
  if ('error' in target) return err(target.error);

  const goal = getGoalByAgent(target.agentName, target.roomId);
  return ok({ ok: true, goal: goal ?? null });
}
