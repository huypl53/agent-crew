import { getQueue } from '../delivery/pane-queue.ts';
import { resolveAgentRuntime } from '../shared/hook-runtime.ts';
import { assertRole } from '../shared/role-guard.ts';
import type { ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { addMessage, getAgent } from '../state/index.ts';

interface InterruptWorkerParams {
  worker_name: string;
  room: string;
  name: string;
}

export async function handleInterruptWorker(
  params: InterruptWorkerParams,
): Promise<ToolResult> {
  const { worker_name, room, name } = params;

  if (!worker_name || !room || !name) {
    return err('Missing required params: worker_name, room, name');
  }

  // Role check: leader only
  try {
    assertRole(name, ['leader'], 'interrupt_worker');
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

  const agentRuntime = await resolveAgentRuntime(
    worker.agent_type,
    worker.tmux_target,
  );

  // Send Escape or Sigint (priority — jumps to front of queue)
  if (agentRuntime === 'claude-code' || agentRuntime === 'codex') {
    await getQueue(worker.tmux_target).enqueue({ type: 'sigint' });
  } else {
    await getQueue(worker.tmux_target).enqueue({ type: 'escape' });
  }

  // Record and send system notification to worker
  const notifyBody = `Your current assignment was interrupted by ${name}`;
  const notifyText = `[system@${room}]: ${notifyBody}`;
  addMessage(worker_name, 'system', room, notifyBody, worker_name);
  await getQueue(worker.tmux_target).enqueue({
    type: 'paste',
    text: notifyText,
  });

  return ok({ interrupted: true });
}
