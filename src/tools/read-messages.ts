import { ok, err } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { getAgent, readMessages, syncFromDisk } from '../state/index.ts';

interface ReadMessagesParams {
  name: string;
  room?: string;
  since_sequence?: number;
}

export async function handleReadMessages(params: ReadMessagesParams): Promise<ToolResult> {
  const { name, room, since_sequence } = params;

  if (!name) {
    return err('Missing required param: name');
  }

  await syncFromDisk();
  const agent = getAgent(name);
  if (!agent) {
    return err(`Agent "${name}" is not registered`);
  }

  const result = readMessages(name, room, since_sequence);

  return ok({
    messages: result.messages.map(m => ({
      message_id: m.message_id,
      from: m.from,
      room: m.room,
      to: m.to,
      text: m.text,
      timestamp: m.timestamp,
      sequence: m.sequence,
      mode: m.mode,
    })),
    next_sequence: result.next_sequence,
  });
}
