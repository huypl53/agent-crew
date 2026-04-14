import { ok, err } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { getAgent, getRoom, getRoomMembers } from '../state/index.ts';
import { deliverMessage } from '../delivery/index.ts';
import { getQueue } from '../delivery/pane-queue.ts';

interface SendMessageParams {
  room: string;
  text: string;
  to?: string;
  mode?: 'push' | 'pull';
  name: string; // sender identity
  kind?: string; // MessageKind — defaults to 'chat'
  reply_to?: number;
  /** Sender's tmux pane ID for push-based status updates. Falls back to TMUX_PANE env var. */
  sender_pane?: string;
}

export async function handleSendMessage(params: SendMessageParams): Promise<ToolResult> {
  const { room, text, to, mode = 'push', name, kind, reply_to, sender_pane } = params;

  if (!room || !text || !name) {
    return err('Missing required params: room, text, name');
  }

  const sender = getAgent(name);
  if (!sender) {
    return err(`Sender "${name}" is not registered`);
  }

  if (!sender.rooms.includes(room)) {
    return err(`Sender "${name}" is not a member of room "${room}"`);
  }

  const r = getRoom(room);
  if (!r) {
    return err(`Room "${room}" does not exist`);
  }

  if (kind === 'task' && !to) {
    return err('Task messages require a "to" param — broadcast tasks are not supported');
  }

  // Validate target if directed message
  if (to) {
    const target = getAgent(to);
    if (!target) {
      return err(`Target agent "${to}" is not registered`);
    }
    if (!target.rooms.includes(room)) {
      return err(`Target "${to}" is not a member of room "${room}"`);
    }
  }

  const results = await deliverMessage(name, room, text, to ?? null, mode, kind as any, reply_to);

  // Push-based status update: when a worker sends a completion, immediately push
  // a structured status notification to all leaders in the room. This supplements
  // the auto-notify in deliverMessage (which uses a plain text format) with a
  // machine-readable status line that leaders can act on without polling.
  // NOTE: pane-discovery (Phase 1) will enhance this with sender pane verification
  // once feat/sender-id is merged. For now we resolve the pane from params or env.
  if (kind === 'completion' && sender.role === 'worker') {
    const resolvedPane = sender_pane ?? process.env.TMUX_PANE ?? sender.tmux_target;
    const members = getRoomMembers(room);
    const leaders = members.filter(m => m.role === 'leader' && m.name !== name && m.tmux_target);
    if (leaders.length > 0) {
      const statusLine = `[status@${room}]: ${name} worker_completed pane=${resolvedPane ?? 'unknown'}`;
      for (const leader of leaders) {
        getQueue(leader.tmux_target!, leader.role)
          .enqueue({ type: 'paste', text: statusLine })
          .catch(() => {}); // best-effort: don't fail the completion send on push error
      }
    }
  }

  if (results.length === 1) {
    return ok({
      message_id: results[0]!.message_id,
      delivered: results[0]!.delivered,
      queued: results[0]!.queued,
      ...(results[0]!.task_id !== undefined && { task_id: results[0]!.task_id }),
    });
  }

  // Broadcast: return summary
  const delivered = results.filter(r => r.delivered).length;
  return ok({
    broadcast: true,
    recipients: results.length,
    delivered,
    queued: results.length,
    message_ids: results.map(r => r.message_id),
  });
}
