import type { ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getRoom, getRoomMembers } from '../state/index.ts';
import { getContextWindowForPane } from '../tokens/claude-code.ts';
import { resolveAgentLiveStatus } from './get-status.ts';

interface ListMembersParams {
  room: string;
}

export async function handleListMembers(
  params: ListMembersParams,
): Promise<ToolResult> {
  const { room } = params;

  if (!room) {
    return err('Missing required param: room');
  }

  const r = getRoom(room);
  if (!r) {
    return err(`Room "${room}" does not exist`);
  }

  const members = await Promise.all(
    getRoomMembers(r.id).map(async (agent) => {
      const status = await resolveAgentLiveStatus(agent);
      let ctx_pct: number | null = null;
      if (agent.tmux_target) {
        try {
          const cw = await getContextWindowForPane(agent.tmux_target);
          if (cw) ctx_pct = cw.context_pct;
        } catch {
          // fail-open
        }
      }
      return {
        agent_id: agent.agent_id,
        name: agent.name,
        role: agent.role,
        status,
        input_block_mode: agent.input_block_mode,
        tmux_target: agent.tmux_target,
        ctx_pct,
      };
    }),
  );

  return ok({ room, topic: r.topic ?? null, members });
}
