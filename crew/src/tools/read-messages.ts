import type { ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getAgent, readMessages, readRoomMessages } from '../state/index.ts';

interface ReadMessagesParams {
  name: string;
  room?: string;
  since_sequence?: number;
  kinds?: string[];
  limit?: number;
}

function mapMsg(m: {
  message_id: string;
  from: string;
  room_id: number;
  to: string | null;
  text: string;
  kind: string;
  timestamp: string;
  sequence: number;
  mode: string;
}) {
  return {
    message_id: m.message_id,
    from: m.from,
    room_id: m.room_id,
    to: m.to,
    text: m.text,
    kind: m.kind,
    timestamp: m.timestamp,
    sequence: m.sequence,
    mode: m.mode,
  };
}

export async function handleReadMessages(
  params: ReadMessagesParams,
): Promise<ToolResult> {
  const { name, room, since_sequence, kinds, limit } = params;

  if (!name) {
    return err('Missing required param: name');
  }

  const agent = getAgent(name);
  if (!agent) {
    return err(`Agent "${name}" is not registered`);
  }

  if (room) {
    // Read from room log with cursor (advances cursor automatically)
    const result = readRoomMessages(name, room, kinds, limit);
    return ok({
      messages: result.messages.map(mapMsg),
      next_sequence: result.next_sequence,
    });
  }

  // Fallback: legacy inbox read
  const result = readMessages(name, undefined, since_sequence);
  return ok({
    messages: result.messages.map((m) =>
      mapMsg({ ...m, kind: m.kind ?? 'chat' }),
    ),
    next_sequence: result.next_sequence,
  });
}
