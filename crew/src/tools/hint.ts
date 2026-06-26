import type { Agent, ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { initDb } from '../state/db.ts';
import {
  getAgentByPane,
  getAgentByRoomAndName,
  getHint,
  getRoom,
  setHint,
  tickHintCadence,
  unsetHint,
} from '../state/index.ts';

type HintTarget =
  | {
      agentName: string;
      roomName: string;
      roomId: number;
      agent: Agent;
      pane: string | null;
    }
  | { error: string };

/**
 * Resolve the target agent/room for hint operations.
 * Auto-detects from TMUX_PANE when possible; validates explicit flags.
 * Returns fully resolved data (room + agent) to avoid redundant lookups.
 */
function resolveHintTarget(params: {
  agent?: string;
  room?: string;
  name?: string;
}): HintTarget {
  const explicitAgentName = params.agent ?? params.name;
  const explicitRoomName = params.room;
  const pane = process.env.TMUX_PANE ?? null;
  const paneAgent = pane ? getAgentByPane(pane) : undefined;

  // Both explicit — resolve room and agent
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
    };
  }

  // Auto-detect from pane
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
    };
  }

  if (!explicitAgentName || !explicitRoomName) {
    return {
      error:
        'No registered agent found for current pane. Run from a registered agent pane or pass both --agent and --room explicitly.',
    };
  }

  // Won't reach here (caught above), but satisfies type checker
  return {
    error:
      'No registered agent found for current pane. Run from a registered agent pane or pass both --agent and --room explicitly.',
  };
}

/**
 * Set a registered-agent hint for an agent.
 * Usage: crew hint set "message text" [-c N] [--agent <name> --room <room>]
 */
export async function handleHintSet(params: {
  agent?: string;
  room?: string;
  name?: string;
  message?: string;
  cadence?: number;
}): Promise<ToolResult> {
  initDb();

  if (!params.message?.trim()) {
    return err(
      'Message is required. Example: crew hint set "You are worker-1 in project-x."',
    );
  }
  const cadence =
    params.cadence != null ? Math.max(1, Math.floor(params.cadence)) : 3;
  if (params.cadence != null && cadence !== params.cadence) {
    return err(
      `-c/--cadence must be a positive integer (got ${params.cadence})`,
    );
  }

  const target = resolveHintTarget(params);
  if ('error' in target) return err(target.error);

  const hint = setHint(target.agentName, target.roomId, params.message.trim(), {
    pane: target.agent.tmux_target ?? target.pane ?? undefined,
    cadence,
  });

  return ok({
    ok: true,
    hint: {
      agent_name: hint.agent_name,
      pane_bootstrap: hint.pane_bootstrap,
      room_id: hint.room_id,
      room_name: target.roomName,
      message: hint.message,
      cadence: hint.cadence,
      status: `Hint set for ${target.agentName} in ${target.roomName}. Will inject your message every ${cadence} turn(s).`,
    },
  });
}

/**
 * Unset a registered-agent hint for an agent.
 * Usage: crew hint unset [--agent <name> --room <room>]
 */
export async function handleHintUnset(params: {
  agent?: string;
  room?: string;
  name?: string;
}): Promise<ToolResult> {
  initDb();

  const target = resolveHintTarget(params);
  if ('error' in target) return err(target.error);

  const removed = unsetHint(target.agentName, target.roomId);
  if (!removed)
    return err(`No hint found for ${target.agentName} in ${target.roomName}`);

  return ok({
    ok: true,
    message: `Hint removed for ${target.agentName} in ${target.roomName}`,
  });
}

/**
 * Read-only hint lookup — returns current hint state WITHOUT advancing the
 * cadence counter. For the production path (cadence ticking), see
 * `crew hook-event` which calls tickHintCadence on UserPromptSubmit.
 *
 * Usage: crew hint lookup [--session <id>] [--pane <tmux-pane>]
 */
export async function handleHintLookup(params: {
  session?: string;
  pane?: string;
}): Promise<ToolResult> {
  const sessionId = params.session ?? null;
  const pane = params.pane ?? process.env.TMUX_PANE;

  if (!pane) return err('Pane is required (--pane or TMUX_PANE env)');

  initDb();

  const hint = getHint(pane, sessionId);

  if (!hint) {
    return ok({ ok: true, hint: null });
  }

  return ok({
    ok: true,
    hint: {
      agent_name: hint.agent_name,
      turn_count: hint.turn_count,
      message: hint.message,
      cadence: hint.cadence,
      next_reminder_at: hint.cadence - (hint.turn_count % hint.cadence),
    },
  });
}
