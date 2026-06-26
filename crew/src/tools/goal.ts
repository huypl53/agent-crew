import { logServer } from '../shared/server-log.ts';
import type { Agent, ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { initDb } from '../state/db.ts';
import {
  clearGoalOutputs,
  completeGoal,
  flushGoalCompletionIfReady,
  getAgentByPane,
  getAgentByRoomAndName,
  getGoal,
  getGoalByAgent,
  getGoalById,
  getGoalHistory,
  getRoom,
  getRoomGoalOverview,
  setGoal,
  unpauseGoalReminder,
  unsetGoal,
  updateGoalDescription,
} from '../state/index.ts';
import { getContextWindowForPane } from '../tokens/claude-code.ts';

type GoalTarget =
  | {
      agentName: string;
      roomName: string;
      roomId: number;
      agent: Agent;
      pane: string | null;
    }
  | { error: string };

/** Resolve target agent/room for goal operations. Auto-detects from TMUX_PANE. */
function resolveGoalTarget(params: {
  agent?: string;
  room?: string;
}): GoalTarget & { callerName?: string } {
  const explicitAgentName = params.agent;
  const explicitRoomName = params.room;
  const pane = process.env.TMUX_PANE ?? null;
  const paneAgent = pane ? getAgentByPane(pane) : undefined;

  if (explicitAgentName && explicitRoomName) {
    const room = getRoom(explicitRoomName);
    if (!room) return { error: `Room not found: ${explicitRoomName}` };
    const agent = getAgentByRoomAndName(room.id, explicitAgentName);
    if (!agent)
      return {
        error: `Agent ${explicitAgentName} is not in room ${explicitRoomName}`,
      };
    return {
      agentName: explicitAgentName,
      roomName: explicitRoomName,
      roomId: room.id,
      agent,
      pane,
      callerName: paneAgent?.name,
    };
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
    error:
      'No registered agent found for current pane. Run from a registered agent pane or pass both --agent and --room explicitly.',
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
    return err(
      'Message is required. Example: crew goal set "Implement auth module"',
    );
  }

  const target = resolveGoalTarget(params);
  if ('error' in target) {
    logServer('WARN', `[goal:handleGoalSet] resolve failed: ${target.error}`);
    return err(target.error);
  }

  // If caller differs from target agent, setBy = caller name; otherwise 'self'
  const setBy =
    target.callerName && target.callerName !== target.agentName
      ? target.callerName
      : 'self';

  logServer(
    'INFO',
    `[goal:handleGoalSet] caller=${target.callerName ?? '?'} target=${target.agentName} setBy=${setBy}`,
  );

  const goal = setGoal(target.agentName, target.roomId, params.message.trim(), {
    pane: target.agent.tmux_target ?? target.pane ?? undefined,
    setBy,
  });

  let ctx_pct: number | null = null;
  if (target.agent.tmux_target) {
    try {
      const cw = await getContextWindowForPane(target.agent.tmux_target);
      if (cw) ctx_pct = cw.context_pct;
    } catch {}
  }

  return ok({
    ok: true,
    goal: {
      agent_name: goal.agent_name,
      room_name: target.roomName,
      description: goal.description,
      status: goal.status,
      turn_count: goal.turn_count,
      ctx_pct,
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
  if ('error' in target) {
    logServer('WARN', `[goal:handleGoalDone] resolve failed: ${target.error}`);
    return err(target.error);
  }

  const done = completeGoal(target.agentName, target.roomId);
  if (!done) {
    logServer(
      'DEBUG',
      `[goal:handleGoalDone] no active goal for ${target.agentName} in ${target.roomName}`,
    );
    return err(
      `No active goal found for ${target.agentName} in ${target.roomName}`,
    );
  }

  flushGoalCompletionIfReady(target.agentName, target.roomId);

  let ctx_pct: number | null = null;
  if (target.agent.tmux_target) {
    try {
      const cw = await getContextWindowForPane(target.agent.tmux_target);
      if (cw) ctx_pct = cw.context_pct;
    } catch {}
  }

  return ok({
    ok: true,
    goal_status: 'done',
    message: `Goal completed for ${target.agentName} in ${target.roomName}`,
    ctx_pct,
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
    return err(
      'Message is required. Example: crew goal update "New description"',
    );
  }

  const target = resolveGoalTarget(params);
  if ('error' in target) {
    logServer(
      'WARN',
      `[goal:handleGoalUpdate] resolve failed: ${target.error}`,
    );
    return err(target.error);
  }

  const updated = updateGoalDescription(
    target.agentName,
    target.roomId,
    params.message.trim(),
  );
  if (!updated) {
    logServer(
      'DEBUG',
      `[goal:handleGoalUpdate] no active goal for ${target.agentName} in ${target.roomName}`,
    );
    return err(
      `No active goal found for ${target.agentName} in ${target.roomName}`,
    );
  }

  // New description = new context. Reset the stuck-detector window and resume
  // reminders in case the loop was paused.
  const goal = getGoalByAgent(target.agentName, target.roomId);
  if (!goal) {
    return err(
      `Goal updated but could not reload the active goal for ${target.agentName} in ${target.roomName}`,
    );
  }
  clearGoalOutputs(goal.id);
  unpauseGoalReminder(goal.id);

  let ctx_pct: number | null = null;
  if (target.agent.tmux_target) {
    try {
      const cw = await getContextWindowForPane(target.agent.tmux_target);
      if (cw) ctx_pct = cw.context_pct;
    } catch {}
  }

  return ok({
    ok: true,
    goal: {
      agent_name: goal.agent_name,
      room_name: target.roomName,
      description: goal.description,
      status: goal.status,
      turn_count: goal.turn_count,
      ctx_pct,
    },
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
  if ('error' in target) {
    logServer('WARN', `[goal:handleGoalUnset] resolve failed: ${target.error}`);
    return err(target.error);
  }

  const removed = unsetGoal(target.agentName, target.roomId);
  if (!removed) {
    logServer(
      'DEBUG',
      `[goal:handleGoalUnset] no goal for ${target.agentName} in ${target.roomName}`,
    );
    return err(`No goal found for ${target.agentName} in ${target.roomName}`);
  }

  let ctx_pct: number | null = null;
  if (target.agent.tmux_target) {
    try {
      const cw = await getContextWindowForPane(target.agent.tmux_target);
      if (cw) ctx_pct = cw.context_pct;
    } catch {}
  }

  return ok({
    ok: true,
    removed: true,
    goal_status: 'unset',
    message: `Goal removed for ${target.agentName} in ${target.roomName}`,
    ctx_pct,
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
    logServer(
      'DEBUG',
      `[goal:handleGoalLookup] session=${sessionId} pane=${pane} → ${goal ? goal.agent_name : 'null'}`,
    );
    if (goal) {
      let ctx_pct: number | null = null;
      const agent = getAgentByRoomAndName(goal.room_id, goal.agent_name);
      if (agent && agent.tmux_target) {
        try {
          const cw = await getContextWindowForPane(agent.tmux_target);
          if (cw) ctx_pct = cw.context_pct;
        } catch {}
      }
      return ok({
        ok: true,
        goal: {
          ...goal,
          ctx_pct,
        },
      });
    }
    return ok({ ok: true, goal: null });
  }

  // Agent-based lookup
  const target = resolveGoalTarget(params);
  if ('error' in target) {
    logServer(
      'WARN',
      `[goal:handleGoalLookup] resolve failed: ${target.error}`,
    );
    return err(target.error);
  }

  const goal = getGoalByAgent(target.agentName, target.roomId);
  if (goal) {
    let ctx_pct: number | null = null;
    if (target.agent.tmux_target) {
      try {
        const cw = await getContextWindowForPane(target.agent.tmux_target);
        if (cw) ctx_pct = cw.context_pct;
      } catch {}
    }
    return ok({
      ok: true,
      goal: {
        ...goal,
        ctx_pct,
      },
    });
  }
  return ok({ ok: true, goal: null });
}

/** Resolve a room from --room or the caller's pane. Used by room-scoped goal ops. */
function resolveRoom(params: {
  room?: string;
}): { roomName: string; roomId: number } | { error: string } {
  const explicitRoomName = params.room;
  if (explicitRoomName) {
    const room = getRoom(explicitRoomName);
    if (!room) return { error: `Room not found: ${explicitRoomName}` };
    return { roomName: room.name, roomId: room.id };
  }
  // Auto-detect from registered pane
  const pane = process.env.TMUX_PANE ?? null;
  const paneAgent = pane ? getAgentByPane(pane) : undefined;
  if (paneAgent) {
    return { roomName: paneAgent.room_name, roomId: paneAgent.room_id };
  }
  return {
    error:
      'No registered agent found for current pane. Pass --room explicitly (or run from a registered agent pane).',
  };
}

/** Room goal overview (default `crew goal`). Shows each member's latest goal. */
export async function handleGoalOverview(params: {
  room?: string;
}): Promise<ToolResult> {
  initDb();

  const room = resolveRoom(params);
  if ('error' in room) {
    logServer(
      'WARN',
      `[goal:handleGoalOverview] resolve failed: ${room.error}`,
    );
    return err(room.error);
  }

  const overview = getRoomGoalOverview(room.roomId);
  const goals = await Promise.all(
    overview.map(async (o) => {
      let ctx_pct: number | null = null;
      const agent = getAgentByRoomAndName(room.roomId, o.goal.agent_name);
      if (agent && agent.tmux_target) {
        try {
          const cw = await getContextWindowForPane(agent.tmux_target);
          if (cw) ctx_pct = cw.context_pct;
        } catch {}
      }
      return {
        agent_name: o.goal.agent_name,
        description: o.goal.description,
        status: o.goal.status,
        turn_count: o.goal.turn_count,
        updated_at: o.goal.updated_at,
        ctx_pct,
      };
    }),
  );

  return ok({
    ok: true,
    overview: true,
    room: room.roomName,
    goals,
  });
}

/** List recent goal history for a room (optionally one agent). Usage: crew goal history [--agent X --room Y] */
export async function handleGoalHistory(params: {
  agent?: string;
  room?: string;
}): Promise<ToolResult> {
  initDb();

  const room = resolveRoom(params);
  if ('error' in room) {
    logServer('WARN', `[goal:handleGoalHistory] resolve failed: ${room.error}`);
    return err(room.error);
  }

  const history = getGoalHistory(room.roomId, { agentName: params.agent });
  return ok({
    ok: true,
    history: true,
    room: room.roomName,
    agent: params.agent ?? null,
    goals: history.map((g) => ({
      id: g.id,
      agent_name: g.agent_name,
      description: g.description,
      status: g.status,
      turn_count: g.turn_count,
      updated_at: g.updated_at,
    })),
  });
}

/** Reactivate an old goal by id. Usage: crew goal redo <id> [--room Y] */
export async function handleGoalRedo(params: {
  id?: string;
  room?: string;
}): Promise<ToolResult> {
  initDb();

  const idNum = params.id ? parseInt(params.id, 10) : NaN;
  if (!Number.isInteger(idNum) || idNum <= 0) {
    return err(
      'Goal id is required. Example: crew goal redo 5 (see `crew goal history` for ids)',
    );
  }

  const room = resolveRoom(params);
  if ('error' in room) {
    logServer('WARN', `[goal:handleGoalRedo] resolve failed: ${room.error}`);
    return err(room.error);
  }

  const goal = getGoalById(idNum);
  if (!goal) {
    return err(`No goal found with id ${idNum}`);
  }
  // Ownership guard: the goal must belong to the resolved room
  if (goal.room_id !== room.roomId) {
    logServer(
      'WARN',
      `[goal:handleGoalRedo] id ${idNum} room ${goal.room_id} != ${room.roomId}`,
    );
    return err(`Goal ${idNum} does not belong to room ${room.roomName}`);
  }
  const targetAgent = getAgentByRoomAndName(goal.room_id, goal.agent_name);
  let ctx_pct: number | null = null;
  if (targetAgent?.tmux_target) {
    try {
      const cw = await getContextWindowForPane(targetAgent.tmux_target);
      if (cw) ctx_pct = cw.context_pct;
    } catch {}
  }

  // No-op if this goal is already active — avoid retiring+re-inserting a duplicate.
  if (goal.status === 'active') {
    return ok({
      ok: true,
      goal: {
        agent_name: goal.agent_name,
        room_name: room.roomName,
        description: goal.description,
        status: goal.status,
        turn_count: goal.turn_count,
        redone_from: idNum,
        ctx_pct,
      },
      message: `Goal ${idNum} is already active for ${goal.agent_name} in ${room.roomName}`,
    });
  }

  const pane = process.env.TMUX_PANE ?? null;
  const paneAgent = pane ? getAgentByPane(pane) : undefined;
  const setBy =
    paneAgent && paneAgent.name !== goal.agent_name ? paneAgent.name : 'self';

  // Bind the reactivated goal to the TARGET agent's pane (not the caller's),
  // so pane-driven lookups (getGoal, tickGoalTurnCount) resolve correctly.
  // Mirrors handleGoalSet's `agent.tmux_target ?? pane` precedence.
  const goalPane = targetAgent?.tmux_target ?? pane ?? undefined;

  const reactivated = setGoal(goal.agent_name, goal.room_id, goal.description, {
    pane: goalPane,
    setBy,
  });

  logServer(
    'INFO',
    `[goal:handleGoalRedo] reactivated id=${idNum} agent=${goal.agent_name} room=${room.roomName} setBy=${setBy}`,
  );
  return ok({
    ok: true,
    goal: {
      agent_name: reactivated.agent_name,
      room_name: room.roomName,
      description: reactivated.description,
      status: reactivated.status,
      turn_count: reactivated.turn_count,
      redone_from: idNum,
      ctx_pct,
    },
    message: `Reactivated goal ${idNum} for ${reactivated.agent_name} in ${room.roomName}`,
  });
}
