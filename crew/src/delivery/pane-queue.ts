import { config } from '../config.ts';

export class PaneDeliveryError extends Error {
  constructor(
    message: string,
    public readonly code: 'PANE_DEAD' | 'DELIVERY_FAILED' | 'PANE_NOT_READY_TYPING',
  ) {
    super(message);
    this.name = 'PaneDeliveryError';
  }
}
import { getPaneStatus } from '../shared/pane-status.ts';
import { logServer } from '../shared/server-log.ts';
import type { AgentRole } from '../shared/types.ts';
import {
  paneExists,
  sendClear,
  sendCommand,
  sendEscape,
  sendKeys,
} from '../tmux/index.ts';

export type QueueItem =
  | { type: 'paste'; text: string } // content message — gets role suffix
  | { type: 'command'; text: string } // CLI command (/rename, crew join, etc.) — no suffix
  | { type: 'escape' }
  | { type: 'clear' };

interface QueueEntry {
  item: QueueItem;
  resolve: () => void;
  reject: (err: Error) => void;
}

const MAX_WAIT_MS = 10_000;
const HEARTBEAT_STALE_MS = 30_000;

// Role-aware suffix appended to every push message
const ROLE_SUFFIX: Record<string, string> = {
  leader:
    '--- Remember: You are a leader. Manage workers, assign tasks, track progress.',
  worker: '--- Remember: You are a worker. Execute tasks, report results.',
  boss: '--- Remember: You are the boss. Direct leaders, review milestones.',
};

// Role-based intervals for 'reduced' profile (ms)
const POLL_INTERVALS: Record<string, number> = {
  worker: 2_000,
  leader: 5_000,
  boss: 10_000,
  default: 2_000,
};

/**
 * Returns the polling interval (ms) for a pane based on the active polling
 * profile and optional agent metadata.
 *
 * Falls back to conservative (500ms) if last_activity indicates the agent has
 * been silent for more than HEARTBEAT_STALE_MS — ensures responsiveness when
 * the agent may be in distress.
 */
export function getPollingInterval(
  role?: AgentRole | string,
  lastActivityMs?: number,
): number {
  // Fallback to conservative if no recent heartbeat
  if (lastActivityMs !== undefined) {
    if (Date.now() - lastActivityMs > HEARTBEAT_STALE_MS) {
      return 500; // conservative fallback
    }
  }

  if (config.pollingProfile === 'conservative') {
    return 500;
  }

  // Reduced profile — role-based intervals
  return POLL_INTERVALS[role ?? 'default'] ?? POLL_INTERVALS.default;
}

export interface PaneQueueOptions {
  /** Agent role — used for role-based polling interval. */
  role?: AgentRole | string;
  /** Last activity timestamp in epoch ms — used for heartbeat-stale fallback. */
  lastActivityMs?: number;
  /** Optional override for leader paste pacing interval in milliseconds. */
  leaderPaceMs?: number;
}

export class PaneQueue {
  private queue: QueueEntry[] = [];
  private processing = false;
  readonly target: string;
  private lockPromise: Promise<void> = Promise.resolve();
  private role?: AgentRole | string;
  private lastActivityMs?: number;
  private leaderPaceMs?: number;
  private lastPasteDeliveredAt = 0;

  constructor(target: string, options?: PaneQueueOptions) {
    this.target = target;
    this.role = options?.role;
    this.lastActivityMs = options?.lastActivityMs;
    this.leaderPaceMs = options?.leaderPaceMs;
  }

  /** Update agent metadata so interval calculations stay current. */
  updateOptions(options: PaneQueueOptions): void {
    if (options.role !== undefined) this.role = options.role;
    if (options.lastActivityMs !== undefined)
      this.lastActivityMs = options.lastActivityMs;
    if (options.leaderPaceMs !== undefined) this.leaderPaceMs = options.leaderPaceMs;
  }

  enqueue(item: QueueItem): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = { item, resolve, reject };
      if (item.type === 'escape') {
        this.queue.unshift(entry);
      } else {
        this.queue.push(entry);
      }
      if (!this.processing) {
        this.processing = true;
        queueMicrotask(() => this.process());
      }
    });
  }

  private async process(): Promise<void> {
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      try {
        if (entry.item.type !== 'escape') {
          await this.waitForReady();
        }
        await this.withLock(async () => {
          await this.applyLeaderPacing(entry.item);
          await this.deliver(entry.item);
        });
        entry.resolve();
      } catch (err) {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    this.processing = false;
  }

  private async waitForReady(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < MAX_WAIT_MS) {
      const result = await getPaneStatus(this.target);
      if (!result.typingActive) return;
      await Bun.sleep(getPollingInterval(this.role, this.lastActivityMs));
    }
    throw new PaneDeliveryError(
      `pane ${this.target} not ready: typing/busy timeout`,
      'PANE_NOT_READY_TYPING',
    );
  }

  private async applyLeaderPacing(item: QueueItem): Promise<void> {
    if (this.role !== 'leader' || item.type !== 'paste') return;
    const paceMs = this.leaderPaceMs ?? config.leaderPaceMs;
    const elapsed = Date.now() - this.lastPasteDeliveredAt;
    if (this.lastPasteDeliveredAt > 0 && elapsed < paceMs) {
      await Bun.sleep(paceMs - elapsed);
    }
  }

  private async deliver(item: QueueItem): Promise<void> {
    // Check if pane still exists before delivery
    if (!(await paneExists(this.target))) {
      logServer(
        'WARN',
        `pane-queue: pane ${this.target} is dead, skipping delivery`,
      );
      throw new PaneDeliveryError(
        `pane ${this.target} no longer exists`,
        'PANE_DEAD',
      );
    }

    switch (item.type) {
      case 'paste': {
        let text = item.text;
        const suffix = this.role ? ROLE_SUFFIX[this.role] : undefined;
        if (suffix) text += '\n' + suffix;
        const r = await sendKeys(this.target, text);
        if (!r.delivered)
          throw new PaneDeliveryError(
            r.error ?? 'paste delivery failed',
            'DELIVERY_FAILED',
          );
        this.lastPasteDeliveredAt = Date.now();
        break;
      }
      case 'command': {
        const r = await sendCommand(this.target, item.text);
        if (!r.delivered)
          throw new PaneDeliveryError(
            r.error ?? 'command delivery failed',
            'DELIVERY_FAILED',
          );
        break;
      }
      case 'escape': {
        const r = await sendEscape(this.target);
        if (!r.delivered)
          throw new PaneDeliveryError(
            r.error ?? 'escape delivery failed',
            'DELIVERY_FAILED',
          );
        break;
      }
      case 'clear': {
        const r = await sendClear(this.target);
        if (!r.delivered)
          throw new PaneDeliveryError(
            r.error ?? 'clear delivery failed',
            'DELIVERY_FAILED',
          );
        break;
      }
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    // Async mutex: wait for any prior lock holder to finish, then run exclusively
    const prev = this.lockPromise;
    let releaseLock: () => void;
    this.lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      releaseLock!();
    }
  }
}

const queues = new Map<string, PaneQueue>();

export function removeQueue(target: string): void {
  queues.delete(target);
}

export function getQueue(
  target: string,
  options?: PaneQueueOptions,
): PaneQueue {
  let q = queues.get(target);
  if (!q) {
    q = new PaneQueue(target, options);
    queues.set(target, q);
  } else if (options) {
    q.updateOptions(options);
  }
  return q;
}
