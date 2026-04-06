import { ok } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { getAllRooms, getRoomMembers } from '../state/index.ts';

export async function handleListRooms(): Promise<ToolResult> {
  const allRooms = getAllRooms();

  const rooms = allRooms.map(room => {
    const members = getRoomMembers(room.name);
    const roles = { boss: 0, leader: 0, worker: 0 };
    for (const m of members) {
      if (m.role in roles) {
        roles[m.role as keyof typeof roles]++;
      }
    }
    return {
      name: room.name,
      member_count: members.length,
      roles,
    };
  });

  return ok({ rooms });
}
