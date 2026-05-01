import { getQueue } from '../delivery/pane-queue.ts';
import { getPaneStatus, parsePaneInputSection } from '../shared/pane-status.ts';import { logServer } from '../shared/server-log.ts';
import type { SweepBusyMode } from '../shared/types.ts';
import {
  getAllAgents,
  getRoomMembers,
  getSweepControlState,
  getTasksForAgent,
  isAgentIdleMuted,
  markAgentStale,
  setAgentStatus,
} from '../state/index.ts';
import {
  capturePane,
  capturePaneTail,
  capturePaneWithAnsi,
  paneCommandLooksAlive,
} from '../tmux/index.ts';

const SWEEP_INTERVAL_MS = 5_000;
const IDLE_THRESHOLD_MS = 60_000;
const ANSI_CHECK_LINES = 8;
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

interface WorkerState {
  textHash: number;
  ansiHash: number; // hash of status region with ANSI codes (catches color-only changes)
  stableSince: number;
}

const workerStates = new Map<string, WorkerState>();
const lastNotified = new Map<string, number>();
const deadCounts = new Map<string, number>();
const deferredByLeader = new Map<string, Map<string, string>>();
const leaderBusyUntil = new Map<string, number>();

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

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash;
}

function computeDeferredTotal(): number {
  let total = 0;
  for (const msgs of deferredByLeader.values()) total += msgs.size;
  return total;
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
): Promise<boolean> {
  if (workerMsgs.size === 0) return true;
  try {
    await getQueue(target, { role: 'leader' }).enqueue({
      type: 'paste',
      text: Array.from(workerMsgs.values()).join('\n'),
    });
    lastFlushCount = workerMsgs.size;
    return true;
  } catch (e) {
    logServer(
      'WARN',
      `Failed to notify leader at ${target}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
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
    const delivered = await deliverCollapsed(target, merged);
    if (delivered) {
      deferredByLeader.delete(target);
      if (merged.size > 0) {
        emitSweepEvent('flush', control, {
          leader: target,
          source: decision.source,
          flush_count: merged.size,
        });
      }
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

async function runIdleDetection(): Promise<void> {
  const agents = getAllAgents();
  const workers = agents.filter((a) => a.role === 'worker' && a.tmux_target);
  if (workers.length === 0) {
    await processDelivery(new Map());
    return;
  }

  const notificationsByLeader = new Map<string, Map<string, string>>();

  for (const w of workers) {
    const target = w.tmux_target as string;
    const alive = await paneCommandLooksAlive(target);

    if (!alive) {
      workerStates.delete(w.name);
      await maybeNotify(w, 'process exited', notificationsByLeader);
      continue;
    }

    const [content, ansiContent] = await Promise.all([
      capturePane(target),
      capturePaneWithAnsi(target, ANSI_CHECK_LINES),
    ]);
    if (content === null) continue;

    const parsedInput = parsePaneInputSection(content);
    if (parsedInput.typingActive) {
      continue;
    }

    const textHash = simpleHash(parsedInput.sanitized);
    const ansiHash = simpleHash(ansiContent ?? '');
    const prev = workerStates.get(w.name);
    const now = Date.now();

    // Check if either text or ANSI changed (catches "thinking" color animations)
    const textChanged = !prev || textHash !== prev.textHash;
    const ansiChanged = !prev || ansiHash !== prev.ansiHash;

    if (textChanged || ansiChanged) {
      workerStates.set(w.name, { textHash, ansiHash, stableSince: now });
      lastNotified.delete(w.name);
      continue;
    }

    const stableMs = now - prev.stableSince;
    if (stableMs >= IDLE_THRESHOLD_MS) {
      await maybeNotify(
        w,
        `idle (${Math.round(stableMs / 60_000)}m)`,
        notificationsByLeader,
      );
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
      if (agent.role === 'worker') {
        const hasContent = workerStates.has(agent.name);
        const stableMs = hasContent
          ? Date.now() - (workerStates.get(agent.name)?.stableSince ?? 0)
          : 0;
        setAgentStatus(
          agent.name,
          stableMs >= IDLE_THRESHOLD_MS ? 'idle' : 'busy',
        );
      }
      continue;
    }

    const count = (deadCounts.get(agent.name) ?? 0) + 1;
    deadCounts.set(agent.name, count);

    if (agent.role === 'boss' || agent.role === 'leader') {
      setAgentStatus(agent.name, 'dead');
      logServer(
        'LIVENESS',
        `${agent.role} ${agent.name} (pane ${agent.tmux_target}) appears dead (count=${count}), not removing`,
      );
      continue;
    }

    const activeTasks = getTasksForAgent(agent.name, [
      'active',
      'sent',
      'queued',
    ]);
    if (activeTasks.length > 0) {
      logServer(
        'LIVENESS',
        `Worker ${agent.name} appears dead but has ${activeTasks.length} active task(s), skipping removal`,
      );
      continue;
    }

    if (count >= DEAD_THRESHOLD) {
      logServer(
        'LIVENESS',
        `Removing dead worker ${agent.name} (confirmed dead ${count}x, no active tasks)`,
      );
      markAgentStale(agent.name);
      deadCounts.delete(agent.name);
      workerStates.delete(agent.name);
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
): Promise<void> {
  const last = lastNotified.get(w.name);
  if (last && Date.now() - last < NOTIFY_THROTTLE_MS) return;

  lastNotified.set(w.name, Date.now());

  let context = '';
  const tail = await capturePaneTail(w.tmux_target as string, 20).catch(
    () => null,
  );
  if (tail) {
    const sanitized = parsePaneInputSection(tail).sanitized;
    const flat = sanitized
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' | ');
    if (flat) context = ` [context: ${flat}]`;
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

export function getWorkerSweepStates(): Record<
  string,
  { content_stable_ms: number; last_notified_at: string | null }
> {
  const now = Date.now();
  const result: Record<
    string,
    { content_stable_ms: number; last_notified_at: string | null }
  > = {};
  for (const [name, state] of workerStates) {
    const last = lastNotified.get(name);
    result[name] = {
      content_stable_ms: now - state.stableSince,
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
