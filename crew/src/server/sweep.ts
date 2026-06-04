import {
  getQueue,
  PaneDeliveryError,
  removeQueue,
} from '../delivery/pane-queue.ts';
import { getPaneStatus } from '../shared/pane-status.ts';
import { logServer } from '../shared/server-log.ts';
import type { SweepBusyMode } from '../shared/types.ts';
import {
  getActivePartyRooms,
  getAllAgents,
  getLatestHookEvent,
  getPendingPartyWorkers,
  getRoomMembers,
  getSweepControlState,
  isAgentIdleMuted,
  markAgentStale,
  setAgentStatus,
} from '../state/index.ts';
import { paneCommandLooksAlive } from '../tmux/index.ts';

const SWEEP_INTERVAL_MS = 5_000;
const IDLE_THRESHOLD_MS = 60_000;
const NOTIFY_THROTTLE_MS = 30 * 60_000;
const LIVENESS_TICKS = 6;
const WARMUP_MS = 30_000;
const DEAD_THRESHOLD = 2;
const AUTO_BUSY_WINDOW_MS = 15_000;
const MAX_DEFERRED_PER_LEADER = 200;

let intervalId: ReturnType<typeof setInterval> | null = null;
let sweeping = false;
let tickCount = 0;
let startedAt = 0;

const lastNotified = new Map<string, number>();
const idleEpochNotified = new Map<string, boolean>();
const deadCounts = new Map<string, number>();
const deferredByLeader = new Map<string, Map<string, string>>();
const leaderBusyUntil = new Map<string, number>();
const partyTimeoutNotified = new Map<string, boolean>();

const PARTY_ROUND_TIMEOUT_MS =
  parseInt(process.env.CREW_PARTY_TIMEOUT_MS ?? '300000', 10) || 300000;

let coalescedUpdates = 0;
let lastFlushCount = 0;
let lastControlKey = '';
let lastEventAt: string | null = null;

export interface SweepRuntimeStats {
  paused: boolean;
  busy_mode: SweepBusyMode;
  deferred_total: number;
  coalesced_updates: number;
  last_flush_count: number;
  last_event_at: string | null;
}

export interface SweepEvent {
  type: 'state' | 'flush' | 'defer';
  paused: boolean;
  busy_mode: SweepBusyMode;
  deferred: number;
  coalesced: number;
  flush_count?: number;
  leader?: string;
  source?: 'manual' | 'auto';
}

let sweepEventListener: ((event: SweepEvent) => void) | null = null;

export function setSweepEventListener(
  listener: ((event: SweepEvent) => void) | null,
): void {
  sweepEventListener = listener;
}

function computeDeferredTotal(): number {
  let total = 0;
  for (const msgs of deferredByLeader.values()) total += msgs.size;
  return total;
}

export function shouldNotifyIdleTransition(workerName: string): boolean {
  if (idleEpochNotified.get(workerName)) return false;
  idleEpochNotified.set(workerName, true);
  return true;
}

export function resetIdleTransition(workerName: string): void {
  idleEpochNotified.delete(workerName);
}

export function getSweepRuntimeStats(): SweepRuntimeStats {
  const control = getSweepControlState();
  return {
    paused: control.delivery_paused,
    busy_mode: control.busy_mode,
    deferred_total: computeDeferredTotal(),
    coalesced_updates: coalescedUpdates,
    last_flush_count: lastFlushCount,
    last_event_at: lastEventAt,
  };
}

function emitSweepEvent(
  type: SweepEvent['type'],
  control: { delivery_paused: boolean; busy_mode: SweepBusyMode },
  extra: Partial<SweepEvent> = {},
): void {
  const event: SweepEvent = {
    type,
    paused: control.delivery_paused,
    busy_mode: control.busy_mode,
    deferred: computeDeferredTotal(),
    coalesced: coalescedUpdates,
    ...extra,
  };
  lastEventAt = new Date().toISOString();
  sweepEventListener?.(event);
}

function stageDeferred(target: string, messages: Map<string, string>): void {
  const staged = deferredByLeader.get(target) ?? new Map<string, string>();
  for (const [worker, text] of messages) {
    if (staged.has(worker)) coalescedUpdates += 1;
    staged.set(worker, text);
  }
  while (staged.size > MAX_DEFERRED_PER_LEADER) {
    const firstKey = staged.keys().next().value as string | undefined;
    if (!firstKey) break;
    staged.delete(firstKey);
  }
  deferredByLeader.set(target, staged);
}

function mergeMessages(
  base: Map<string, string> | undefined,
  incoming: Map<string, string>,
): Map<string, string> {
  const merged = new Map<string, string>(base ?? []);
  for (const [worker, text] of incoming) {
    if (merged.has(worker)) coalescedUpdates += 1;
    merged.set(worker, text);
  }
  return merged;
}

async function deliverCollapsed(
  target: string,
  workerMsgs: Map<string, string>,
): Promise<{ delivered: boolean; deadPane: boolean; typingDeferred: boolean }> {
  if (workerMsgs.size === 0)
    return { delivered: true, deadPane: false, typingDeferred: false };
  try {
    await getQueue(target, { role: 'leader' }).enqueue({
      type: 'paste',
      text: Array.from(workerMsgs.values()).join('\n'),
    });
    lastFlushCount = workerMsgs.size;
    return { delivered: true, deadPane: false, typingDeferred: false };
  } catch (e) {
    const deadPane = e instanceof PaneDeliveryError && e.code === 'PANE_DEAD';
    const typingDeferred =
      e instanceof PaneDeliveryError &&
      (e.code === 'PANE_NOT_READY_TYPING' || e.code === 'PANE_BLOCKED_INPUT');
    logServer(
      'WARN',
      `Failed to notify leader at ${target}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { delivered: false, deadPane, typingDeferred };
  }
}

async function isLeaderBusyAuto(target: string): Promise<boolean> {
  const now = Date.now();
  try {
    const status = await getPaneStatus(target);
    if (status.status === 'busy' || status.contentChanged) {
      leaderBusyUntil.set(target, now + AUTO_BUSY_WINDOW_MS);
    }
  } catch {
    // ignore probe failure, use sticky window only
  }
  return (leaderBusyUntil.get(target) ?? 0) > now;
}

async function shouldDeferForLeader(
  target: string,
  control: { delivery_paused: boolean; busy_mode: SweepBusyMode },
): Promise<{ defer: boolean; source: 'manual' | 'auto' }> {
  if (control.delivery_paused) return { defer: true, source: 'manual' };
  if (control.busy_mode === 'manual_busy')
    return { defer: true, source: 'manual' };
  if (control.busy_mode === 'manual_free')
    return { defer: false, source: 'manual' };
  return { defer: await isLeaderBusyAuto(target), source: 'auto' };
}

async function processDelivery(
  notificationsByLeader: Map<string, Map<string, string>>,
): Promise<void> {
  const control = getSweepControlState();
  const controlKey = `${control.delivery_paused}|${control.busy_mode}|${control.pause_reason ?? ''}`;
  if (controlKey !== lastControlKey) {
    lastControlKey = controlKey;
    emitSweepEvent('state', control);
  }

  const targets = new Set<string>([
    ...notificationsByLeader.keys(),
    ...deferredByLeader.keys(),
  ]);

  for (const target of targets) {
    const incoming =
      notificationsByLeader.get(target) ?? new Map<string, string>();
    const decision = await shouldDeferForLeader(target, control);

    if (decision.defer) {
      if (incoming.size > 0) {
        stageDeferred(target, incoming);
        emitSweepEvent('defer', control, {
          leader: target,
          source: decision.source,
        });
      }
      continue;
    }

    const merged = mergeMessages(deferredByLeader.get(target), incoming);
    const result = await deliverCollapsed(target, merged);
    if (result.delivered) {
      deferredByLeader.delete(target);
      if (merged.size > 0) {
        emitSweepEvent('flush', control, {
          leader: target,
          source: decision.source,
          flush_count: merged.size,
        });
      }
    } else if (result.deadPane) {
      deferredByLeader.delete(target);
      removeQueue(target);
    } else {
      stageDeferred(target, merged);
    }
  }
}

async function runSweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  tickCount++;
  try {
    await runIdleDetection();
    await runPartyTimeoutCheck();
    if (tickCount % LIVENESS_TICKS === 0) {
      await runLivenessCheck();
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

async function runPartyTimeoutCheck(): Promise<void> {
  const activeParties = getActivePartyRooms();
  const now = Date.now();

  for (const room of activeParties) {
    const key = `${room.id}:${room.party_round}`;

    if (partyTimeoutNotified.get(key)) continue;

    const startedAt = new Date(room.party_started_at + 'Z').getTime();
    const elapsed = now - startedAt;

    if (elapsed < PARTY_ROUND_TIMEOUT_MS) continue;

    const pending = getPendingPartyWorkers(room.id, room.party_round);
    if (pending.length === 0) continue;

    partyTimeoutNotified.set(key, true);
    await notifyPartyTimeout(room.id, room.name, room.party_round, pending);
  }
}

async function notifyPartyTimeout(
  roomId: number,
  roomName: string,
  round: number,
  pending: string[],
): Promise<void> {
  const leaders = getRoomMembers(roomId).filter(
    (m) => m.role === 'leader' && m.tmux_target,
  );

  const message = `[party@${roomName}] Round ${round} timeout. Pending workers: ${pending.join(', ')}

Use "crew party skip --worker <name>" to skip, or wait for responses.`;

  for (const leader of leaders) {
    try {
      const queue = getQueue(leader.tmux_target!, { role: 'leader' });
      await queue.enqueue({ type: 'paste', text: message });
    } catch {
      // Ignore delivery failures
    }
  }

  logServer(
    'PARTY',
    `Round ${round} timeout in room ${roomName}, pending: ${pending.join(', ')}`,
  );
}

async function runIdleDetection(): Promise<void> {
  const agents = getAllAgents();
  const workers = agents.filter((a) => a.role === 'worker' && a.tmux_target);
  if (workers.length === 0) {
    await processDelivery(new Map());
    return;
  }

  const notificationsByLeader = new Map<string, Map<string, string>>();
  const now = Date.now();

  for (const w of workers) {
    const target = w.tmux_target as string;
    const alive = await paneCommandLooksAlive(target);

    if (!alive) {
      await maybeNotify(w, 'process exited', notificationsByLeader);
      continue;
    }

    // Query hook events for idle detection
    const stopEvent = getLatestHookEvent(w.name, 'Stop');
    const submitEvent = getLatestHookEvent(w.name, 'UserPromptSubmit');

    // If most recent event is UserPromptSubmit (agent is busy), reset idle tracking
    if (
      submitEvent &&
      (!stopEvent || submitEvent.id > stopEvent.id)
    ) {
      lastNotified.delete(w.name);
      resetIdleTransition(w.name);
      continue;
    }

    // If no Stop event yet, no idle data
    if (!stopEvent) continue;

    const elapsedMs = now - new Date(stopEvent.created_at + 'Z').getTime();
    if (elapsedMs >= IDLE_THRESHOLD_MS && shouldNotifyIdleTransition(w.name)) {
      const reason = `idle (${Math.round(elapsedMs / 60_000)}m)`;
      await maybeNotify(w, reason, notificationsByLeader, stopEvent.payload);
    }
  }

  await processDelivery(notificationsByLeader);
}

async function runLivenessCheck(): Promise<void> {
  if (Date.now() - startedAt < WARMUP_MS) return;

  const agents = getAllAgents();
  for (const agent of agents) {
    if (!agent.tmux_target) continue;

    const alive = await paneCommandLooksAlive(agent.tmux_target);

    if (alive) {
      deadCounts.delete(agent.name);
      // Status is now set by hook events, but fallback for workers without hooks
      if (agent.role === 'worker') {
        const hookStatus = getLatestHookEvent(agent.name);
        if (!hookStatus) {
          // No hook data — set based on liveness only
          setAgentStatus(agent.name, 'busy');
        }
      }
      continue;
    }

    const count = (deadCounts.get(agent.name) ?? 0) + 1;
    deadCounts.set(agent.name, count);

    if (agent.role === 'leader') {
      setAgentStatus(agent.name, 'dead');
      logServer(
        'LIVENESS',
        `${agent.role} ${agent.name} (pane ${agent.tmux_target}) appears dead (count=${count}), not removing`,
      );
      continue;
    }

    if (count >= DEAD_THRESHOLD) {
      logServer(
        'LIVENESS',
        `Removing dead worker ${agent.name} (confirmed dead ${count}x)`,
      );
      markAgentStale(agent.name);
      deadCounts.delete(agent.name);
      resetIdleTransition(agent.name);
    } else {
      logServer(
        'LIVENESS',
        `Worker ${agent.name} appears dead (count=${count}/${DEAD_THRESHOLD})`,
      );
    }
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
  notificationsByLeader: Map<string, Map<string, string>>,
  hookPayload?: string | null,
): Promise<void> {
  const last = lastNotified.get(w.name);
  if (last && Date.now() - last < NOTIFY_THROTTLE_MS) return;

  lastNotified.set(w.name, Date.now());

  let context = '';
  // Use last_assistant_message from hook payload instead of tmux capture
  if (hookPayload) {
    try {
      const parsed = JSON.parse(hookPayload) as { last_assistant_message?: string };
      if (parsed.last_assistant_message) {
        const msg = parsed.last_assistant_message
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .join(' | ');
        const truncated = msg.length > 300 ? `${msg.slice(0, 297)}...` : msg;
        if (truncated) context = ` [context: ${truncated}]`;
      }
    } catch {
      // payload parse failed — no context
    }
  }

  const notifyText = `[system@${w.room_name}]: ${w.name} ${reason}${context}`;

  const roomMembers = getRoomMembers(w.room_id);
  const leaders = roomMembers.filter(
    (m) => m.role === 'leader' && m.tmux_target && !isAgentIdleMuted(m.name),
  );

  for (const leader of leaders) {
    const target = leader.tmux_target as string;
    const byWorker =
      notificationsByLeader.get(target) ?? new Map<string, string>();
    if (byWorker.has(w.name)) coalescedUpdates += 1;
    byWorker.set(w.name, notifyText);
    notificationsByLeader.set(target, byWorker);
  }

  logServer('SWEEP', `Worker ${w.name} ${reason}, staging notify for leaders`);
}

export function resetSweepIdleTracking(): void {
  idleEpochNotified.clear();
}

export function resetPartyTimeoutTracking(roomId: number): void {
  for (const key of partyTimeoutNotified.keys()) {
    if (key.startsWith(`${roomId}:`)) {
      partyTimeoutNotified.delete(key);
    }
  }
}

export function getWorkerSweepStates(): Record<
  string,
  { content_stable_ms: number; last_notified_at: string | null }
> {
  const now = Date.now();
  const result: Record<
    string,
    { content_stable_ms: number; last_notified_at: string | null }
  > = {};
  const agents = getAllAgents().filter((a) => a.role === 'worker');
  for (const agent of agents) {
    const stopEvent = getLatestHookEvent(agent.name, 'Stop');
    const last = lastNotified.get(agent.name);
    result[agent.name] = {
      content_stable_ms: stopEvent
        ? now - new Date(stopEvent.created_at + 'Z').getTime()
        : 0,
      last_notified_at: last ? new Date(last).toISOString() : null,
    };
  }
  return result;
}

export function startSweep(): void {
  if (intervalId) return;
  startedAt = Date.now();
  tickCount = 0;
  lastControlKey = '';
  coalescedUpdates = 0;
  lastFlushCount = 0;
  runSweep();
  intervalId = setInterval(runSweep, SWEEP_INTERVAL_MS);
  logServer(
    'START',
    'Worker sweep started (5s interval, 1m idle, 30s liveness)',
  );
}

export function stopSweep(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
