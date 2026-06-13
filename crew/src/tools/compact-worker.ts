import { getQueue } from '../delivery/pane-queue.ts';
import { assertRole } from '../shared/role-guard.ts';
import type { ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getAgent } from '../state/index.ts';

interface CompactWorkerParams {
  worker_name: string;
  room: string;
  name: string;
  message?: string;
}

export async function handleCompactWorker(
  params: CompactWorkerParams,
): Promise<ToolResult> {
  const { worker_name, room, name, message } = params;

  if (!worker_name || !room || !name) {
    return err('Missing required params: worker_name, room, name');
  }

  // Role check: leader only
  try {
    assertRole(name, ['leader'], 'compact_worker');
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }

  // Validate worker exists and is in room
  const worker = getAgent(worker_name);
  if (!worker) {
    return err(`Worker "${worker_name}" is not registered`);
  }
  if (worker.role !== 'worker') {
    return err(
      `Target "${worker_name}" is not a worker (got role: ${worker.role})`,
    );
  }
  if (!(worker.room_name === room || worker.room_path === room)) {
    return err(`Worker "${worker_name}" is not in room "${room}"`);
  }
  if (!worker.tmux_target) {
    return err(`Worker "${worker_name}" has no tmux target`);
  }

  // Send /compact [message] to the worker's pane
  const commandText = message ? `/compact ${message}` : '/compact';
  try {
    await getQueue(worker.tmux_target).enqueue({
      type: 'command',
      text: commandText,
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }

  return ok({
    compacted: true,
    worker_name,
    room,
    message: `Sent "${commandText}" to ${worker_name}. Context will be compacted.`,
  });
}
