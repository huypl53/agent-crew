import { addMessage, getAgent, getRoomMembers, createTask, markAgentStale } from '../state/index.ts';
import { paneCommandLooksAlive } from '../tmux/index.ts';
import { getQueue } from './pane-queue.ts';
import { getDb } from '../state/db.ts';
import type { Message, MessageKind } from '../shared/types.ts';

const NOTIFY_KINDS: MessageKind[] = ['completion', 'error', 'question'];

interface DeliveryResult {
  message_id: string;
  delivered: boolean;
  queued: boolean;
  error?: string;
  task_id?: number;
}

// --- Delivery ACK tracking ---

/**
 * Record a pending delivery ACK for a message sent to a pane.
 * This allows us to track whether messages are actually being received.
 */
export function recordPendingAck(messageId: number, targetPane: string): void {
  const db = getDb();
  const sentAt = Date.now();
  db.run(
    'INSERT OR REPLACE INTO delivery_acks (message_id, target_pane, sent_at, acked_at) VALUES (?, ?, ?, NULL)',
    [messageId, targetPane, sentAt],
  );
}

/**
 * Mark a delivery ACK as received.
 * Called by the `crew ack` command when a recipient acknowledges a message.
 */
export function markAckReceived(messageId: number, targetPane: string): boolean {
  const db = getDb();
  const ackedAt = Date.now();
  const result = db.run(
    'UPDATE delivery_acks SET acked_at = ? WHERE message_id = ? AND target_pane = ? AND acked_at IS NULL',
    [ackedAt, messageId, targetPane],
  );
  return result.changes > 0;
}

/**
 * Query for pending ACKs (messages sent but not yet acknowledged).
 * Returns messages sent more than `timeoutMs` ago that haven't been ACKed.
 * Use timeoutMs=0 to get all pending ACKs regardless of elapsed time.
 */
export function getPendingAcks(timeoutMs: number = 10000): Array<{ message_id: number; target_pane: string; sent_at: number; elapsed_ms: number }> {
  const db = getDb();
  const now = Date.now();
  // When timeoutMs is 0, return all pending ACKs; otherwise apply the timeout filter
  const rows = db.query(
    timeoutMs === 0
      ? 'SELECT message_id, target_pane, sent_at FROM delivery_acks WHERE acked_at IS NULL'
      : 'SELECT message_id, target_pane, sent_at FROM delivery_acks WHERE acked_at IS NULL AND ? - sent_at > ?',
  ).all(...(timeoutMs === 0 ? [] : [now, timeoutMs])) as Array<{ message_id: number; target_pane: string; sent_at: number }>;

  return rows.map(row => ({
    message_id: row.message_id,
    target_pane: row.target_pane,
    sent_at: row.sent_at,
    elapsed_ms: now - row.sent_at,
  }));
}

/**
 * Get ACK status for a specific message.
 */
export function getAckStatus(messageId: number, targetPane: string): { sent_at: number; acked_at: number | null } | null {
  const db = getDb();
  const row = db.query(
    'SELECT sent_at, acked_at FROM delivery_acks WHERE message_id = ? AND target_pane = ?',
  ).get(messageId, targetPane) as { sent_at: number; acked_at: number | null } | null;
  return row;
}

export async function deliverMessage(
  senderName: string,
  room: string,
  text: string,
  targetName: string | null,
  mode: 'push' | 'pull',
  kind: MessageKind = 'chat',
  replyTo?: number | null,
): Promise<DeliveryResult[]> {
  const header = `[${senderName}@${room}]:`;
  const fullText = `${header} ${text}`;

  // Determine recipients
  let targets: string[];
  if (targetName) {
    targets = [targetName];
  } else {
    // Broadcast: all room members except sender
    const members = getRoomMembers(room);
    targets = members.filter(m => m.name !== senderName).map(m => m.name);
  }

  const results: DeliveryResult[] = [];

  for (const to of targets) {
    // Always queue first (NFR6)
    // For broadcast (targetName=null), store each recipient's copy with their name
    const msg = addMessage(to, senderName, room, text, mode, targetName ?? to, kind, replyTo);

    let taskId: number | undefined;
    if (kind === 'task') {
      const task = createTask(room, targetName ?? to, senderName, Number(msg.message_id), text);
      taskId = task.id;
    }

    if (mode === 'push') {
      const agent = getAgent(to);
      if (agent) {
        if (!agent.tmux_target) {
          results.push({ message_id: msg.message_id, delivered: false, queued: true, error: 'pull-only agent: no tmux pane', task_id: taskId });
          continue;
        }
        // For known agent types, verify the pane is still running an agent process
        // before delivery. A plain shell means the worker restarted without refreshing
        // its registration — pasting there would inject text into the wrong terminal.
        if (agent.agent_type === 'claude-code' || agent.agent_type === 'codex') {
          if (!await paneCommandLooksAlive(agent.tmux_target)) {
            markAgentStale(agent.name);
            results.push({
              message_id: msg.message_id,
              delivered: false,
              queued: true,
              error: `stale-target: pane ${agent.tmux_target} is not running an agent process`,
              task_id: taskId,
            });
            continue;
          }
        }
        try {
          await getQueue(agent.tmux_target).enqueue({ type: 'paste', text: fullText });
          // Record pending ACK for tracking delivery confirmation
          recordPendingAck(Number(msg.message_id), agent.tmux_target);
          results.push({ message_id: msg.message_id, delivered: true, queued: true, task_id: taskId });
        } catch (e) {
          results.push({
            message_id: msg.message_id,
            delivered: false,
            queued: true,
            error: e instanceof Error ? e.message : String(e),
            task_id: taskId,
          });
        }
      } else {
        results.push({ message_id: msg.message_id, delivered: false, queued: true, error: 'Agent not found', task_id: taskId });
      }
    } else {
      // Pull mode: queue only
      results.push({ message_id: msg.message_id, delivered: false, queued: true, task_id: taskId });
    }
  }

  // Auto-notify: if sender is worker and kind is notifiable, push brief summary to leaders
  if (NOTIFY_KINDS.includes(kind)) {
    const sender = getAgent(senderName);
    if (sender?.role === 'worker') {
      const members = getRoomMembers(room);
      const leaders = members.filter(m => m.role === 'leader' && m.name !== senderName);
      const summary = text.length > 80 ? text.slice(0, 77) + '...' : text;
      const notifyText = `[system@${room}]: ${senderName} ${kind}: "${summary}"`;

      for (const leader of leaders) {
        getQueue(leader.tmux_target).enqueue({ type: 'paste', text: notifyText }).catch(() => {});
      }
    }
  }

  return results;
}
