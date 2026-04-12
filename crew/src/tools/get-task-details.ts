import { ok, err } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { getTaskDetails } from '../state/index.ts';

interface GetTaskDetailsParams {
  task_id: number;
}

export async function handleGetTaskDetails(params: GetTaskDetailsParams): Promise<ToolResult> {
  const { task_id } = params;
  if (!task_id) return err('Missing required param: task_id');

  const task = getTaskDetails(task_id);
  if (!task) return err(`Task ${task_id} not found`);

  return ok(task);
}
