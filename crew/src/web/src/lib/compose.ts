import type { Message } from '../types.ts';

export interface MessagePayload {
  room: string;
  to?: string;
  text: string;
  kind: string;
  mode: string;
  replyTo?: number;
}

/** Builds the POST /api/messages body from composer state. */
export function buildMessagePayload(
  room: string,
  text: string,
  to: string,
  kind: string,
  mode: string,
  replyTarget: Message | null,
): MessagePayload {
  return {
    room,
    to: to || undefined,
    text: text.trim(),
    kind,
    mode,
    ...(replyTarget ? { replyTo: Number(replyTarget.message_id) } : {}),
  };
}
