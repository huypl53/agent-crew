import type { ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getDb } from '../state/db.ts';
import {
  getAgentByRoomAndName,
  getRoom,
  getRoomMembers,
} from '../state/index.ts';

interface DeleteRoomParams {
  room: string;
  confirm?: boolean;
  name?: string;
}

export function handleDeleteRoom(params: DeleteRoomParams): ToolResult {
  const { room, confirm = false, name } = params;

  if (!room) return err('Missing required param: room');
  if (!name) return err('Missing required param: name');

  const roomData = getRoom(room);
  if (!roomData) return err(`Room "${room}" does not exist`);

  const caller = getAgentByRoomAndName(roomData.id, name);
  if (!caller || caller.role !== 'leader') {
    return err(
      `Agent "${name}" must be a leader in room "${room}" to delete it`,
    );
  }

  const members = getRoomMembers(roomData.id);
  const db = getDb();
  const { count: msgCount } = db
    .query('SELECT COUNT(*) as count FROM messages WHERE room_id = ?')
    .get(roomData.id) as { count: number };

  if (!confirm) {
    return err(
      `Use --confirm to delete room "${room}" (${members.length} members, ${msgCount} messages will be removed)`,
    );
  }

  // CASCADE on rooms table handles agents, messages, and cursors.
  db.run('DELETE FROM rooms WHERE id = ?', [roomData.id]);

  return ok({
    deleted: true,
    room,
    removed_members: members.map((a) => a.name),
    messages_deleted: msgCount,
  });
}
