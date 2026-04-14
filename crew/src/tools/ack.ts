import { ok, err } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { markAckReceived, getAckStatus } from '../delivery/index.ts';

interface AckParams {
  messageId?: number;
  pane?: string;
}

export async function handleAck(params: AckParams): Promise<ToolResult> {
  const { messageId, pane } = params;

  // Resolve pane from environment if not provided
  const targetPane = pane || process.env.TMUX_PANE;
  if (!targetPane) {
    return err('Missing required param: pane (set TMUX_PANE env var or provide --pane param)');
  }

  if (!messageId) {
    return err('Missing required param: message-id');
  }

  // Mark the ACK as received
  const updated = markAckReceived(messageId, targetPane);
  if (!updated) {
    return err(`No pending ACK found for message_id=${messageId}, pane=${targetPane} (already acknowledged or never sent)`);
  }

  // Get the updated status
  const status = getAckStatus(messageId, targetPane);
  if (!status) {
    return err('Failed to retrieve ACK status after update');
  }

  const elapsed = status.acked_at ? status.acked_at - status.sent_at : 0;

  return ok({
    message_id: messageId,
    pane: targetPane,
    sent_at: new Date(status.sent_at).toISOString(),
    acked_at: status.acked_at ? new Date(status.acked_at).toISOString() : null,
    elapsed_ms: elapsed,
    status: 'acknowledged',
  });
}
