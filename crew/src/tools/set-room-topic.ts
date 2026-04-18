import { ok, err } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { getAgent, getRoom, setRoomTopic } from '../state/index.ts';

interface SetRoomTopicParams {
  room: string;
  text: string;
  name: string;
}

export async function handleSetRoomTopic(params: SetRoomTopicParams): Promise<ToolResult> {
  const { room, text, name } = params;
  if (!room || !text || !name) return err('Missing required params: room, text, name');

  const agent = getAgent(name);
  if (!agent || !(agent.room_name === room || agent.room_path === room)) {
    return err(`Agent "${name}" is not a member of room "${room}"`);
  }

  const r = getRoom(room);
  if (!r) return err(`Room "${room}" does not exist`);

  setRoomTopic(room, text);
  return ok({ room, topic: text });
}
