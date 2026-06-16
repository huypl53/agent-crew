import type { ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getAgent, readRoomMessages } from '../state/index.ts';

interface ReadMessagesParams {
  name: string;
  room?: string;
  limit?: number;
}

function mapMsg(m: {
  message_id: string;
  from: string;
  room_id: number;
  to: string | null;
  text: string;
  timestamp: string;
  sequence: number;
}) {
  return {
    message_id: m.message_id,
    from: m.from,
    room_id: m.room_id,
    to: m.to,
    text: m.text,
    timestamp: m.timestamp,
    sequence: m.sequence,
  };
}

export async function handleReadMessages(
  params: ReadMessagesParams,
): Promise<ToolResult> {
  const { name, room, limit } = params;

  if (!name) {
    return err('Missing required param: name');
  }

  const agent = getAgent(name);
  if (!agent) {
    return err(`Agent "${name}" is not registered`);
  }

  // Always read from the room log. `--room` selects which room; when omitted we
  // resolve it from the agent's own room. The room path includes broadcasts
  // (worker completions) gated by role and advances the read cursor, matching
  // the push delivery path. The legacy inbox read (recipient-only, no
  // broadcasts, no cursor) diverged from `crew inspect`, so it is gone.
  const roomName = room ?? agent.room_name;
  const result = readRoomMessages(name, roomName, limit);
  return ok({
    messages: result.messages.map(mapMsg),
    next_sequence: result.next_sequence,
  });
}
