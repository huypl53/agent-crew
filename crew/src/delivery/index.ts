import { addMessage, getAgent, getRoomMembers, createTask, markAgentStale } from '../state/index.ts';
import { paneCommandLooksAlive } from '../tmux/index.ts';
import { getQueue } from './pane-queue.ts';
import type { Message, MessageKind } from '../shared/types.ts';

const NOTIFY_KINDS: MessageKind[] = ['completion', 'error', 'question'];

interface DeliveryResult {
  message_id: string;
  delivered: boolean;
  queued: boolean;
  error?: string;
  task_id?: number;
}

export async function deliverMessage(
  senderName: string,
  room: string,
  text: string,
  targetName: string | null,
  mode: 'push' | 'pull',
  kind: MessageKind = 'chat',
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
    const msg = addMessage(to, senderName, room, text, mode, targetName ?? to, kind);

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
