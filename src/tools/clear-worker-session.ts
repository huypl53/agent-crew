import { ok, err } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { assertRole } from '../shared/role-guard.ts';
import { getAgent } from '../state/index.ts';
import { getQueue } from '../delivery/pane-queue.ts';

interface ClearWorkerSessionParams {
  worker_name: string;
  room: string;
  name: string;
}

export async function handleClearWorkerSession(params: ClearWorkerSessionParams): Promise<ToolResult> {
  const { worker_name, room, name } = params;

  if (!worker_name || !room || !name) {
    return err('Missing required params: worker_name, room, name');
  }

  // Role check: leader or boss only
  try {
    assertRole(name, ['leader', 'boss'], 'clear_worker_session');
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }

  // Validate worker exists and is in room
  const worker = getAgent(worker_name);
  if (!worker) {
    return err(`Worker "${worker_name}" is not registered`);
  }
  if (!worker.rooms.includes(room)) {
    return err(`Worker "${worker_name}" is not in room "${room}"`);
  }
  if (!worker.tmux_target) {
    return err(`Worker "${worker_name}" has no tmux target`);
  }

  // Step 1: Send /clear to the worker's pane
  await getQueue(worker.tmux_target).enqueue({ type: 'paste', text: '/clear' });

  // Step 2: Wait 2 seconds for CC to process /clear
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Step 3: Send crew:refresh command to re-register the worker
  const refreshText = `/crew:refresh --name ${worker_name}`;
  await getQueue(worker.tmux_target).enqueue({ type: 'paste', text: refreshText });

  return ok({
    cleared: true,
    worker_name,
    room,
    message: `Session cleared and refresh sent. IMPORTANT: ${worker_name}'s context is now blank. Your next task message must be fully self-contained — do not reference prior conversation.`,
  });
}
