import { logServer } from '../shared/server-log.ts';
import type { Agent, PartyResponse } from '../shared/types.ts';
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
    .map((w) => {
      if (w.input_block_mode !== 'off') {
        logServer(
          'INFO',
          `party-delivery: skipping topic delivery to worker ${w.name} (pane ${w.tmux_target}) because input block is active`,
        );
        return null;
      }
      return w.tmux_target ? { target: w.tmux_target, agent: w } : null;
    })
    .filter((x): x is { target: string; agent: Agent } => !!x)
    .map((x) => deliverToPane(x.target, message, 'worker'));

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
    .map((l) => {
      if (l.input_block_mode !== 'off') {
        logServer(
          'INFO',
          `party-delivery: skipping digest delivery to leader ${l.name} (pane ${l.tmux_target}) because input block is active`,
        );
        return null;
      }
      return l.tmux_target ? { target: l.tmux_target, agent: l } : null;
    })
    .filter((x): x is { target: string; agent: Agent } => !!x)
    .map((x) => deliverToPane(x.target, message, 'leader'));

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
    logServer(
      'WARN',
      `party-delivery: failed to deliver to ${target}: ${result.error}`,
    );
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
