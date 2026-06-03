import { deliverMessage } from '../delivery/index.ts';
import { getQueue } from '../delivery/pane-queue.ts';
import { assertRole } from '../shared/role-guard.ts';
import type { ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getAgent } from '../state/index.ts';

interface ReassignTaskParams {
  worker_name: string;
  room: string;
  text: string;
  name: string;
}

export async function handleReassignTask(
  params: ReassignTaskParams,
): Promise<ToolResult> {
  const { worker_name, room, text, name } = params;

  if (!worker_name || !room || !text || !name) {
    return err('Missing required params: worker_name, room, text, name');
  }

  // Role check: leader only
  try {
    assertRole(name, ['leader'], 'reassign_task');
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }

  // Validate worker
  const worker = getAgent(worker_name);
  if (!worker) {
    return err(`Worker "${worker_name}" is not registered`);
  }
  if (!(worker.room_name === room || worker.room_path === room)) {
    return err(`Worker "${worker_name}" is not in room "${room}"`);
  }

  if (!worker.tmux_target) {
    return err(`Worker "${worker_name}" has no tmux target`);
  }

  await getQueue(worker.tmux_target).enqueue({ type: 'escape' });
  await deliverMessage(name, room, text, worker_name, 'push', 'task');

  return ok({ reassigned: true });
}
