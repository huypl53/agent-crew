import { getQueue } from '../delivery/pane-queue.ts';
import { logServer } from '../shared/server-log.ts';
import { getAllAgents, getRoomMembers } from '../state/index.ts';
import {
  capturePane,
  capturePaneTail,
  paneCommandLooksAlive,
} from '../tmux/index.ts';

const SWEEP_INTERVAL_MS = 5_000;
const IDLE_THRESHOLD_MS = 60_000; // 1 min unchanged content = genuinely idle
const NOTIFY_THROTTLE_MS = 30 * 60_000; // 30 min per worker

let intervalId: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

// Per-worker content stability tracking
interface WorkerState {
  hash: number;
  stableSince: number; // epoch ms when content last changed
}

const workerStates = new Map<string, WorkerState>();

// Per-worker notification throttle
const lastNotified = new Map<string, number>();

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash;
}

async function runSweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const agents = getAllAgents();
    const workers = agents.filter((a) => a.role === 'worker' && a.tmux_target);
    if (workers.length === 0) return;

    const notificationsByLeader = new Map<string, string[]>();

    for (const w of workers) {
      const target = w.tmux_target as string;
      const alive = await paneCommandLooksAlive(target);

      // Condition 1: process dead
      if (!alive) {
        workerStates.delete(w.name);
        await maybeNotify(w, 'process exited', notificationsByLeader);
        continue;
      }

      // Condition 2: process alive — check content stability
      const content = await capturePane(target);
      if (content === null) continue;

      const hash = simpleHash(content);
      const prev = workerStates.get(w.name);
      const now = Date.now();

      if (!prev || prev.hash !== hash) {
        // Content changed (or first check) — reset stability timer
        workerStates.set(w.name, { hash, stableSince: now });
        // Worker producing output — clear throttle
        lastNotified.delete(w.name);
        continue;
      }

      // Content unchanged — check if stable long enough
      const stableMs = now - prev.stableSince;
      if (stableMs >= IDLE_THRESHOLD_MS) {
        await maybeNotify(
          w,
          `idle (${Math.round(stableMs / 60_000)}m)`,
          notificationsByLeader,
        );
      }
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

async function maybeNotify(
  w: {
    name: string;
    room_id: number;
    room_name: string;
    tmux_target: string | null;
  },
  reason: string,
  notificationsByLeader: Map<string, string[]>,
): Promise<void> {
  // Throttle — skip if already notified about this worker recently
  const last = lastNotified.get(w.name);
  if (last && Date.now() - last < NOTIFY_THROTTLE_MS) return;

  lastNotified.set(w.name, Date.now());

  // Capture pane context
  let context = '';
  const tail = await capturePaneTail(w.tmux_target as string, 20).catch(
    () => null,
  );
  if (tail) {
    const flat = tail
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' | ');
    if (flat) context = ` [context: ${flat}]`;
  }

  const notifyText = `[system@${w.room_name}]: ${w.name} ${reason}${context}`;

  const roomMembers = getRoomMembers(w.room_id);
  const leaders = roomMembers.filter(
    (m) => m.role === 'leader' && m.tmux_target,
  );

  for (const leader of leaders) {
    const msgs = notificationsByLeader.get(leader.tmux_target as string) ?? [];
    msgs.push(notifyText);
    notificationsByLeader.set(leader.tmux_target as string, msgs);
  }

  logServer('SWEEP', `Worker ${w.name} ${reason}, notifying leaders`);
}

export function startSweep(): void {
  if (intervalId) return;
  runSweep();
  intervalId = setInterval(runSweep, SWEEP_INTERVAL_MS);
  logServer('START', 'Worker sweep started (5s interval, 1m idle threshold)');
}

export function stopSweep(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
