import { sendKeys } from '../tmux/index.ts';
import { addMessage, getAgent, getRoomMembers } from '../state/index.ts';
import type { Message, MessageKind } from '../shared/types.ts';

const NOTIFY_KINDS: MessageKind[] = ['completion', 'error', 'question'];

interface DeliveryResult {
  message_id: string;
  delivered: boolean;
  queued: boolean;
  error?: string;
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

    if (mode === 'push') {
      const agent = getAgent(to);
      if (agent) {
        const delivery = await sendKeys(agent.tmux_target, fullText);
        results.push({
          message_id: msg.message_id,
          delivered: delivery.delivered,
          queued: true,
          error: delivery.error,
        });
      } else {
        results.push({ message_id: msg.message_id, delivered: false, queued: true, error: 'Agent not found' });
      }
    } else {
      // Pull mode: queue only
      results.push({ message_id: msg.message_id, delivered: false, queued: true });
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
        await sendKeys(leader.tmux_target, notifyText);
      }
    }
  }

  return results;
}
