import { assertRole } from '../shared/role-guard.ts';
import type { TaskStatus, ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getTask, updateTaskStatus } from '../state/index.ts';

interface UpdateTaskParams {
  task_id: number;
  status: string;
  note?: string;
  context?: string;
  name: string;
}

const WORKER_ALLOWED: TaskStatus[] = ['queued', 'active', 'completed', 'error'];

export async function handleUpdateTask(
  params: UpdateTaskParams,
): Promise<ToolResult> {
  const { task_id, status, note, context, name } = params;

  if (!task_id || !status || !name) {
    return err('Missing required params: task_id, status, name');
  }

  if (!WORKER_ALLOWED.includes(status as TaskStatus)) {
    return err(
      `Invalid status "${status}". Allowed: ${WORKER_ALLOWED.join(', ')}`,
    );
  }

  // Role check: worker only
  try {
    assertRole(name, ['worker'], 'update_task');
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }

  // Verify task exists and belongs to this worker
  const task = getTask(task_id);
  if (!task) {
    return err(`Task ${task_id} not found`);
  }
  if (task.assigned_to !== name) {
    return err(
      `Task ${task_id} is assigned to "${task.assigned_to}", not "${name}"`,
    );
  }

  const updated = updateTaskStatus(
    task_id,
    status as TaskStatus,
    note,
    context,
  );
  if (!updated) {
    return err(`Failed to update task ${task_id}`);
  }

  return ok({ updated: true, task_id, status: updated.status });
}
