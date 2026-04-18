import { ok, err } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { assertRole } from '../shared/role-guard.ts';
import { getAgent, getTasksForAgent, updateTaskStatus, addMessage } from '../state/index.ts';
import { getQueue } from '../delivery/pane-queue.ts';

interface InterruptWorkerParams {
  worker_name: string;
  room: string;
  name: string;
}

export async function handleInterruptWorker(params: InterruptWorkerParams): Promise<ToolResult> {
  const { worker_name, room, name } = params;

  if (!worker_name || !room || !name) {
    return err('Missing required params: worker_name, room, name');
  }

  // Role check: leader or boss only
  try {
    assertRole(name, ['leader', 'boss'], 'interrupt_worker');
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }

  // Validate worker exists and is in room
  const worker = getAgent(worker_name);
  if (!worker) {
    return err(`Worker "${worker_name}" is not registered`);
  }
  if (!(worker.room_name === room || worker.room_path === room)) {
    return err(`Worker "${worker_name}" is not in room "${room}"`);
  }

  // Find active task
  const activeTasks = getTasksForAgent(worker_name, ['active']);
  if (activeTasks.length === 0) {
    return err(`Worker "${worker_name}" has no active task to interrupt`);
  }

  const task = activeTasks[0]!;

  // Send Escape (priority — jumps to front of queue)
  await getQueue(worker.tmux_target).enqueue({ type: 'escape' });

  // Mark task as interrupted
  updateTaskStatus(task.id, 'interrupted');

  // Record and send system notification to worker
  const notifyBody = `Your current task was interrupted by ${name}`;
  const notifyText = `[system@${room}]: ${notifyBody}`;
  addMessage(worker_name, 'system', room, notifyBody, 'push', worker_name, 'status');
  await getQueue(worker.tmux_target).enqueue({ type: 'paste', text: notifyText });

  return ok({ interrupted: true, task_id: task.id, previous_status: 'active' });
}
