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

  if (!confirm) {
    const members = getRoomMembers(room);
    const db = getDb();
    const { count: msgCount } = db.query('SELECT COUNT(*) as count FROM messages WHERE room = ?').get(room) as { count: number };
    const { count: taskCount } = db.query('SELECT COUNT(*) as count FROM tasks WHERE room = ?').get(room) as { count: number };
    return err(
      `Use --confirm to delete room "${room}" (${members.length} members, ${msgCount} messages, ${taskCount} tasks will be removed)`,
    );
  }

  const db = getDb();
  const memberNames = getRoomMembers(room).map(a => a.name);
  const { count: msgCount } = db.query('SELECT COUNT(*) as count FROM messages WHERE room = ?').get(room) as { count: number };
  const { count: taskCount } = db.query('SELECT COUNT(*) as count FROM tasks WHERE room = ?').get(room) as { count: number };

  db.run('DELETE FROM tasks WHERE room = ?', [room]);
  db.run('DELETE FROM members WHERE room = ?', [room]);
  db.run('DELETE FROM cursors WHERE room = ?', [room]);
  db.run('DELETE FROM messages WHERE room = ?', [room]);
  db.run('DELETE FROM rooms WHERE name = ?', [room]);

  // Remove agents that no longer belong to any room
  for (const agentName of memberNames) {
    const remaining = (db.query('SELECT COUNT(*) as c FROM members WHERE agent = ?').get(agentName) as { c: number }).c;
    if (remaining === 0) {
      db.run('DELETE FROM agents WHERE name = ?', [agentName]);
      db.run('DELETE FROM cursors WHERE agent = ?', [agentName]);
    }
  }

  return ok({ deleted: true, room, removed_members: memberNames, messages_deleted: msgCount, tasks_deleted: taskCount });
}
