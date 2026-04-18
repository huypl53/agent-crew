import type { ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getRoom, getRoomMembers } from '../state/index.ts';

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

  const members = getRoomMembers(r.id).map((agent) => ({
    agent_id: agent.agent_id,
    name: agent.name,
    role: agent.role,
    status: 'unknown',
  }));

  return ok({ room, topic: r.topic ?? null, members });
}
