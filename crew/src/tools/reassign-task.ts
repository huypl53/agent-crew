import { getQueue } from '../delivery/pane-queue.ts';
import { assertRole } from '../shared/role-guard.ts';
import type { ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import {
  addMessage,
  createTask,
  getAgent,
  getTasksForAgent,
  updateTaskStatus,
} from '../state/index.ts';

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

  // Role check: leader or boss only
  try {
    assertRole(name, ['leader', 'boss'], 'reassign_task');
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

  const queue = getQueue(worker.tmux_target);
  let oldTaskId: number | undefined;

  // Check current task state
  const activeTasks = getTasksForAgent(worker_name, ['active']);
  const queuedTasks = getTasksForAgent(worker_name, ['queued']);

  if (activeTasks.length > 0) {
    // Active task: escape to interrupt, then send new task
    const oldTask = activeTasks[0]!;
    oldTaskId = oldTask.id;
    await queue.enqueue({ type: 'escape' });
    updateTaskStatus(oldTask.id, 'interrupted');
  } else if (queuedTasks.length > 0) {
    // Queued task: Ctrl-L to clear input, then send new task
    const oldTask = queuedTasks[0]!;
    oldTaskId = oldTask.id;
    await queue.enqueue({ type: 'clear' });
    updateTaskStatus(oldTask.id, 'cancelled');
  }
  // else: idle — just send new task

  // Queue message and create task record
  const header = `[${name}@${room}]:`;
  const fullText = `${header} ${text}`;
  const msg = addMessage(
    worker_name,
    name,
    room,
    text,
    'push',
    worker_name,
    'task',
  );
  const newTask = createTask(
    room,
    worker_name,
    name,
    Number(msg.message_id),
    text,
  );

  // Deliver new task
  await queue.enqueue({ type: 'paste', text: fullText });

  return ok({
    reassigned: true,
    old_task_id: oldTaskId,
    new_task_id: newTask.id,
  });
}
