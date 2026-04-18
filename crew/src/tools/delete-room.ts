import { ok, err } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { getDb } from '../state/db.ts';
import { getRoom, getRoomMembers } from '../state/index.ts';

interface DeleteRoomParams {
  room: string;
  confirm?: boolean;
  name?: string;
}

export function handleDeleteRoom(params: DeleteRoomParams): ToolResult {
  const { room, confirm = false } = params;

  if (!room) return err('Missing required param: room');

  const roomData = getRoom(room);
  if (!roomData) return err(`Room "${room}" does not exist`);

  const members = getRoomMembers(roomData.id);
  const db = getDb();
  const { count: msgCount } = db.query('SELECT COUNT(*) as count FROM messages WHERE room_id = ?').get(roomData.id) as { count: number };
  const { count: taskCount } = db.query('SELECT COUNT(*) as count FROM tasks WHERE room_id = ?').get(roomData.id) as { count: number };

  if (!confirm) {
    return err(
      `Use --confirm to delete room "${room}" (${members.length} members, ${msgCount} messages, ${taskCount} tasks will be removed)`,
    );
  }

  // CASCADE on rooms table handles agents, messages, tasks, cursors
  db.run('DELETE FROM rooms WHERE id = ?', [roomData.id]);

  return ok({ deleted: true, room, removed_members: members.map(a => a.name), messages_deleted: msgCount, tasks_deleted: taskCount });
}
