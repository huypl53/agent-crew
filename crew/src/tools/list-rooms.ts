import type { ToolResult } from '../shared/types.ts';
import { ok } from '../shared/types.ts';
import { getAllRooms, getRoomMembers } from '../state/index.ts';

export async function handleListRooms(): Promise<ToolResult> {
  const allRooms = getAllRooms();

  const rooms = allRooms.map((room) => {
    const members = getRoomMembers(room.id);
    const roles = { leader: 0, worker: 0 };
    for (const m of members) {
      if (m.role in roles) {
        roles[m.role as keyof typeof roles]++;
      }
    }
    return {
      id: room.id,
      name: room.name,
      path: room.path,
      member_count: members.length,
      roles,
    };
  });

  return ok({ rooms });
}
