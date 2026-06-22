import { inspectWorkerTurns } from '../observation/gateway.ts';
import type { ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getAllAgents, getRoom } from '../state/index.ts';

interface InspectWorkerParams {
  worker_name?: string;
  room?: string;
  name?: string;
  turns?: number;
}

function resolveRoomForWorker(
  workerName: string,
  callerName: string,
  explicitRoom?: string,
): string | null {
  if (explicitRoom) {
    return getRoom(explicitRoom) ? explicitRoom : null;
  }

  const visibleMatches = getAllAgents().filter(
    (agent) =>
      agent.name === workerName &&
      agent.role === 'worker' &&
      getAllAgents().some(
        (member) =>
          member.name === callerName &&
          member.role === 'leader' &&
          member.room_id === agent.room_id,
      ),
  );

  const uniqueRoomIds = [...new Set(visibleMatches.map((agent) => agent.room_id))];
  if (uniqueRoomIds.length === 1) {
    return visibleMatches[0]?.room_path ?? null;
  }
  return null;
}

export async function handleInspectWorker(
  params: InspectWorkerParams,
): Promise<ToolResult> {
  if (!params.worker_name) return err('--worker required');
  if (!params.name) return err('--name required');

  const roomName = resolveRoomForWorker(
    params.worker_name,
    params.name,
    params.room,
  );
  if (!roomName) {
    return err(
      params.room
        ? `Room "${params.room}" not found`
        : `Worker "${params.worker_name}" is ambiguous or not visible to leader "${params.name}". Use --room.`,
    );
  }

  try {
    const snapshot = await inspectWorkerTurns({
      workerName: params.worker_name,
      roomName,
      callerName: params.name,
      turns: params.turns,
    });
    return ok(snapshot as unknown as Record<string, unknown>);
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}
