import { config } from '../config.ts';
import { deliverMessage } from '../delivery/index.ts';
import type { ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getAgent, getRoom } from '../state/index.ts';

interface SendMessageParams {
  room: string;
  text: string;
  to?: string;
  mode?: 'push' | 'pull';
  name: string; // sender identity
  kind?: string; // MessageKind — defaults to 'chat'
  reply_to?: number;
}

export async function handleSendMessage(
  params: SendMessageParams,
): Promise<ToolResult> {
  const { room, text, to, mode = 'push', name, kind, reply_to } = params;

  if (!room || !text || !name) {
    return err('Missing required params: room, text, name');
  }

  const sender = getAgent(name);
  if (!sender) {
    return err(`Sender "${name}" is not registered`);
  }

  const r = getRoom(room);
  if (!r) {
    return err(`Room "${room}" does not exist`);
  }

  if (sender.room_id !== r.id) {
    return err(`Sender "${name}" is not a member of room "${room}"`);
  }

  // Sender verification: compare claimed sender's registered pane against the
  // tmux pane that originated this call (available via $TMUX_PANE in the process env).
  if (config.senderVerification !== 'off') {
    const callerPane = process.env.TMUX_PANE ?? null;
    if (callerPane && sender.tmux_target && callerPane !== sender.tmux_target) {
      const msg = `Sender mismatch: claimed "${name}" (pane ${sender.tmux_target}) but caller is pane ${callerPane}`;
      if (config.senderVerification === 'enforce') {
        return err(msg);
      }
      console.warn(`[sender-verification] ${msg}`);
    }
  }

  if (kind === 'task' && !to) {
    return err(
      'Task messages require a "to" param — broadcast tasks are not supported',
    );
  }

  // Validate target if directed message
  if (to) {
    const target = getAgent(to);
    if (!target) {
      return err(`Target agent "${to}" is not registered`);
    }
    if (target.room_id !== r.id) {
      return err(`Target "${to}" is not a member of room "${room}"`);
    }
  }

  const results = await deliverMessage(
    name,
    room,
    text,
    to ?? null,
    mode,
    kind as any,
    reply_to,
  );

  if (results.length === 1) {
    return ok({
      message_id: results[0]!.message_id,
      delivered: results[0]!.delivered,
      queued: results[0]!.queued,
      ...(results[0]!.task_id !== undefined && {
        task_id: results[0]!.task_id,
      }),
    });
  }

  // Broadcast: return summary
  const delivered = results.filter((r) => r.delivered).length;
  return ok({
    broadcast: true,
    recipients: results.length,
    delivered,
    queued: results.length,
    message_ids: results.map((r) => r.message_id),
  });
}
