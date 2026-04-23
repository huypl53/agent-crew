import { getQueue } from '../delivery/pane-queue.ts';
import { assertRole } from '../shared/role-guard.ts';
import type { ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { cancelQueuedTasksForAgent, getAgent } from '../state/index.ts';

interface ClearWorkerSessionParams {
  worker_name: string;
  room: string;
  name: string;
}

export async function handleClearWorkerSession(
  params: ClearWorkerSessionParams,
): Promise<ToolResult> {
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
  if (!(worker.room_name === room || worker.room_path === room)) {
    return err(`Worker "${worker_name}" is not in room "${room}"`);
  }
  if (!worker.tmux_target) {
    return err(`Worker "${worker_name}" has no tmux target`);
  }

  // Step 1: Cancel queued/sent tasks in DB — worker's context is about to be wiped,
  // so any pending work targeting the old session is no longer valid.
  const cancelled = cancelQueuedTasksForAgent(worker_name, name);

  // Step 2: Send /clear to the worker's pane
  try {
    await getQueue(worker.tmux_target).enqueue({
      type: 'command',
      text: '/clear',
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }

  // Step 3: Wait 2 seconds for CC to process /clear
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Step 4: Send crew:refresh command to re-register the worker
  const refreshText = `/crew:refresh --name ${worker_name}`;
  try {
    await getQueue(worker.tmux_target).enqueue({
      type: 'command',
      text: refreshText,
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }

  // Step 5: Rename Claude Code session to worker name (same as join flow)
  try {
    await getQueue(worker.tmux_target, { role: 'worker' }).enqueue({
      type: 'command',
      text: `/rename ${worker_name}@${room}`,
    });
  } catch {
    // Non-critical — ignore failure
  }

  return ok({
    cleared: true,
    worker_name,
    room,
    cancelled_tasks: cancelled,
    message: `Session cleared and refresh sent. ${cancelled} queued task(s) cancelled. IMPORTANT: ${worker_name}'s context is now blank. Your next task message must be fully self-contained — do not reference prior conversation.`,
  });
}
