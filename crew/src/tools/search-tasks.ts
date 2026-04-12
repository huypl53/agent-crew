import { ok } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { searchTasks } from '../state/index.ts';

interface SearchTasksParams {
  room?: string;
  assigned_to?: string;
  keyword?: string;
  status?: string;
  limit?: number;
}

export async function handleSearchTasks(params: SearchTasksParams): Promise<ToolResult> {
  const results = searchTasks({
    room: params.room,
    assigned_to: params.assigned_to,
    keyword: params.keyword,
    status: params.status ?? 'completed',
    limit: params.limit,
  });

  return ok(results);
}
