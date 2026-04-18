import type { ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getDb } from '../state/db.ts';
import { getRoom } from '../state/index.ts';

interface CreateRoomParams {
  room: string;
  topic?: string;
  name?: string;
}

export function handleCreateRoom(params: CreateRoomParams): ToolResult {
  const { room, topic } = params;

  if (!room) return err('Missing required param: room');
  if (/\s/.test(room))
    return err(
      'Room name must not contain spaces — use underscores or hyphens',
    );
  if (room.length > 32) return err('Room name must be 32 characters or fewer');

  const db = getDb();
  const existing = db.query('SELECT 1 FROM rooms WHERE name = ?').get(room);
  if (existing) return err(`Room "${room}" already exists`);

  const ts = new Date().toISOString();
  db.run(
    'INSERT INTO rooms (path, name, topic, created_at) VALUES (?, ?, ?, ?)',
    [`/room/${room}`, room, topic ?? null, ts],
  );

  const created = getRoom(room)!;
  return ok({
    room: created.name,
    topic: created.topic ?? null,
    created_at: created.created_at,
  });
}
