import type { ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getAgent, removeAgent } from '../state/index.ts';

interface LeaveRoomParams {
  room: string;
  name: string;
}

export async function handleLeaveRoom(
  params: LeaveRoomParams,
): Promise<ToolResult> {
  const { room, name } = params;

  if (!room || !name) {
    return err('Missing required params: room, name');
  }

  const agent = getAgent(name);
  if (!agent) {
    return err(`Agent "${name}" is not registered`);
  }

  if (!(agent.room_name === room || agent.room_path === room)) {
    return err(`Agent "${name}" is not in room "${room}"`);
  }

  removeAgent(name, room);

  return ok({ success: true });
}
