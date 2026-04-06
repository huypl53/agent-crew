import type { Message } from '../shared/types.ts';
import { COLORS } from './terminal.ts';

const MAX_MESSAGES = 500;
const ROOM_COLORS = [COLORS.cyan, COLORS.magenta, COLORS.blue, COLORS.green, COLORS.yellow] as const;

export interface FormattedMessage {
  timestamp: string;
  sender: string;
  room: string;
  target: string;
  text: string;
  kind: string;
  roomColor: string;
}

export class MessageFeed {
  private buffer: FormattedMessage[] = [];
  private roomColorMap = new Map<string, string>();
  private seenIds = new Set<string>();

  get messages(): FormattedMessage[] { return this.buffer; }

  update(messages: Message[]): void {
    const sorted = [...messages].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    for (const msg of sorted) {
      if (this.seenIds.has(msg.message_id)) continue;
      this.seenIds.add(msg.message_id);
      this.buffer.push(this.format(msg));
    }
    if (this.buffer.length > MAX_MESSAGES) {
      this.buffer.splice(0, this.buffer.length - MAX_MESSAGES);
    }
  }

  private format(msg: Message): FormattedMessage {
    const d = new Date(msg.timestamp);
    const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    return {
      timestamp: ts, sender: msg.from, room: msg.room,
      target: msg.to ?? 'ALL', text: msg.text,
      kind: msg.kind ?? 'chat',
      roomColor: this.getRoomColor(msg.room),
    };
  }

  private getRoomColor(room: string): string {
    let c = this.roomColorMap.get(room);
    if (!c) { c = ROOM_COLORS[this.roomColorMap.size % ROOM_COLORS.length]!; this.roomColorMap.set(room, c); }
    return c;
  }
}
