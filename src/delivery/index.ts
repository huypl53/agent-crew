import { sendKeys } from '../tmux/index.ts';
import { addMessage, getAgent, getRoomMembers } from '../state/index.ts';
import type { Message } from '../shared/types.ts';

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
    const msg = addMessage(to, senderName, room, text, mode, targetName);

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

  return results;
}
