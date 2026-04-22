import { getQueue } from '../delivery/pane-queue.ts';
import { getPaneStatus } from '../shared/pane-status.ts';
import { logServer } from '../shared/server-log.ts';
import {
  getAllAgents,
  getRoomMembers,
  getStaleTasksForWorkers,
  touchTaskNotified,
} from '../state/index.ts';

const SWEEP_INTERVAL_MS = 30_000;
const NOTIFY_COOLDOWN_MS = 5 * 60_000; // 5 minutes

let intervalId: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

async function checkWorkerStatus(
  tmuxTarget: string,
): Promise<'idle' | 'busy' | 'unknown'> {
  let result = await getPaneStatus(tmuxTarget);
  if (result.status === 'unknown') {
    await Bun.sleep(3500);
    result = await getPaneStatus(tmuxTarget);
  }
  return result.status;
}

async function runSweep(): Promise<void> {
  if (sweeping) return; // prevent overlapping sweeps
  sweeping = true;
  try {
    const agents = getAllAgents();
    const workers = agents.filter((a) => a.role === 'worker' && a.tmux_target);
    if (workers.length === 0) return;

    // Check workers serially to avoid tmux overload
    const idleWorkers: typeof workers = [];
    for (const w of workers) {
      const status = await checkWorkerStatus(w.tmux_target!);
      if (status === 'idle') idleWorkers.push(w);
    }
    if (idleWorkers.length === 0) return;

    const idleNames = idleWorkers.map((w) => w.name);
    const staleBefore = new Date(Date.now() - NOTIFY_COOLDOWN_MS).toISOString();
    const staleTasks = getStaleTasksForWorkers(idleNames, staleBefore);

    if (staleTasks.length === 0) return;

    // Mark notified BEFORE pushing — prevents duplicate notifications if
    // sweep is interrupted or worker picks up task between query and delivery
    for (const t of staleTasks) {
      touchTaskNotified(t.id);
    }

    // Group stale tasks by worker
    const tasksByWorker = new Map<string, typeof staleTasks>();
    for (const t of staleTasks) {
      const list = tasksByWorker.get(t.assigned_to) ?? [];
      list.push(t);
      tasksByWorker.set(t.assigned_to, list);
    }

    // Batch notifications per leader (avoid flooding a single leader)
    const notificationsByLeader = new Map<string, string[]>();
    for (const [workerName, tasks] of tasksByWorker) {
      const worker = idleWorkers.find((w) => w.name === workerName);
      if (!worker) continue;

      const roomMembers = getRoomMembers(worker.room_id);
      const leaders = roomMembers.filter(
        (m) => m.role === 'leader' && m.tmux_target,
      );
      if (leaders.length === 0) continue;

      const oldestTask = tasks[0]!;
      const age = formatAge(oldestTask.created_at);
      const notifyText = `[system@${worker.room_name}]: ${workerName} idle with ${tasks.length} queued task(s) (oldest: ${age})`;

      for (const leader of leaders) {
        const msgs = notificationsByLeader.get(leader.tmux_target!) ?? [];
        msgs.push(notifyText);
        notificationsByLeader.set(leader.tmux_target!, msgs);
      }

      logServer(
        'SWEEP',
        `Notifying leaders about idle worker ${workerName} (${tasks.length} tasks)`,
      );
    }

    // Deliver batched notifications
    for (const [target, messages] of notificationsByLeader) {
      const batchText = messages.join('\n');
      try {
        await getQueue(target, { role: 'leader' }).enqueue({
          type: 'paste',
          text: batchText,
        });
      } catch (e) {
        logServer(
          'WARN',
          `Failed to notify leader at ${target}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } catch (e) {
    logServer(
      'ERROR',
      `Sweep failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    sweeping = false;
  }
}

function formatAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function startSweep(): void {
  if (intervalId) return;
  runSweep();
  intervalId = setInterval(runSweep, SWEEP_INTERVAL_MS);
  logServer('START', 'Idle-worker sweep started (30s interval)');
}

export function stopSweep(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
