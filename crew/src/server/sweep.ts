import { getQueue } from '../delivery/pane-queue.ts';
import { logServer } from '../shared/server-log.ts';
import { getAllAgents, getRoomMembers } from '../state/index.ts';
import { capturePaneTail, paneCommandLooksAlive } from '../tmux/index.ts';

const SWEEP_INTERVAL_MS = 30_000;
const NOTIFY_THROTTLE_MS = 30 * 60_000; // 30 min per worker

let intervalId: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

// In-memory throttle — skip re-notifying about the same dead worker
const lastNotified = new Map<string, number>();

async function runSweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const agents = getAllAgents();
    const workers = agents.filter((a) => a.role === 'worker' && a.tmux_target);
    if (workers.length === 0) return;

    const notificationsByLeader = new Map<string, string[]>();

    for (const w of workers) {
      const target = w.tmux_target!;
      const alive = await paneCommandLooksAlive(target);
      if (alive) {
        // Worker process running — clear any previous throttle
        lastNotified.delete(w.name);
        continue;
      }

      // Process dead — check throttle
      const last = lastNotified.get(w.name);
      if (last && Date.now() - last < NOTIFY_THROTTLE_MS) continue;

      lastNotified.set(w.name, Date.now());

      // Capture pane context (last 20 lines)
      let context = '';
      const tail = await capturePaneTail(target, 20).catch(() => null);
      if (tail) {
        const flat = tail
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .join(' | ');
        if (flat) context = ` [context: ${flat}]`;
      }

      const notifyText = `[system@${w.room_name}]: ${w.name} process exited${context}`;

      const roomMembers = getRoomMembers(w.room_id);
      const leaders = roomMembers.filter(
        (m) => m.role === 'leader' && m.tmux_target,
      );

      for (const leader of leaders) {
        const msgs = notificationsByLeader.get(leader.tmux_target!) ?? [];
        msgs.push(notifyText);
        notificationsByLeader.set(leader.tmux_target!, msgs);
      }

      logServer('SWEEP', `Worker ${w.name} process exited, notifying leaders`);
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

export function startSweep(): void {
  if (intervalId) return;
  runSweep();
  intervalId = setInterval(runSweep, SWEEP_INTERVAL_MS);
  logServer('START', 'Process-death sweep started (30s interval)');
}

export function stopSweep(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
