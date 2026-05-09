import type { Agent, PartyResponse } from '../shared/types.ts';
import { logServer } from '../shared/server-log.ts';
import { getRoom } from '../state/index.ts';
import { sendKeys } from '../tmux/index.ts';

/**
 * Broadcast topic to workers at start of round.
 * If prevResponses provided (round > 1), include previous round digest.
 */
export async function deliverPartyTopic(
  roomId: number,
  round: number,
  topic: string,
  workers: Agent[],
  prevResponses?: PartyResponse[],
): Promise<void> {
  const room = getRoom(roomId);
  const roomName = room?.name ?? 'unknown';

  let message: string;

  if (round === 1 || !prevResponses?.length) {
    message = `[party@${roomName} round:${round}] Topic: ${topic}

Reply with your perspective on this topic.`;
  } else {
    const responseLines = prevResponses
      .filter((r) => r.response !== '[SKIPPED]')
      .map((r) => `- ${r.agent_name}: ${truncateResponse(r.response)}`)
      .join('\n');

    message = `[party@${roomName} round:${round}] Previous round responses:

${responseLines}

New topic: ${topic}

Reply with your perspective.`;
  }

  const deliveries = workers
    .filter((w) => w.tmux_target)
    .map((w) => deliverToPane(w.tmux_target!, message, 'worker'));

  await Promise.allSettled(deliveries);
}

/**
 * Push round digest to leader only.
 */
export async function deliverPartyDigest(
  roomId: number,
  round: number,
  responses: PartyResponse[],
  leaders: Agent[],
): Promise<void> {
  const room = getRoom(roomId);
  const roomName = room?.name ?? 'unknown';

  const responseLines = responses
    .map((r) => {
      if (r.response === '[SKIPPED]') {
        return `- ${r.agent_name}: [skipped]`;
      }
      return `- ${r.agent_name}: ${truncateResponse(r.response)}`;
    })
    .join('\n');

  const message = `[party@${roomName}] Round ${round} complete. Responses:

${responseLines}

Reply: "crew party next --topic '...'" to continue, or "crew party end" to finish.`;

  const deliveries = leaders
    .filter((l) => l.tmux_target)
    .map((l) => deliverToPane(l.tmux_target!, message, 'leader'));

  await Promise.allSettled(deliveries);
}

async function deliverToPane(
  target: string,
  text: string,
  _role: 'leader' | 'worker',
): Promise<void> {
  // Use sendKeys directly for party messages — bypass waitForReady() which
  // blocks when typingActive is detected (Claude Code suggestions trigger this)
  const result = await sendKeys(target, text);
  if (!result.delivered) {
    logServer('WARN', `party-delivery: failed to deliver to ${target}: ${result.error}`);
  }
}

function truncateResponse(response: string, maxLen = 500): string {
  const cleaned = response
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');

  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 3) + '...';
}
