import type { ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getRoom, getRoomMembers } from '../state/index.ts';
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
      return {
        agent_id: agent.agent_id,
        name: agent.name,
        role: agent.role,
        status,
        input_block_mode: agent.input_block_mode,
        tmux_target: agent.tmux_target,
      };
    }),
  );

  return ok({ room, topic: r.topic ?? null, members });
}
