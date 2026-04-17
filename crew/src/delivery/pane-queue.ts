import { sendKeys, sendEscape, sendClear, capturePane, paneExists } from '../tmux/index.ts';
import { matchStatusLine } from '../shared/status-patterns.ts';
import { config } from '../config.ts';
import type { AgentRole } from '../shared/types.ts';
import { logServer } from '../shared/server-log.ts';

export type QueueItem =
  | { type: 'paste'; text: string }
  | { type: 'escape' }
  | { type: 'clear' };

interface QueueEntry {
  item: QueueItem;
  resolve: () => void;
  reject: (err: Error) => void;
}

const MAX_WAIT_MS = 10_000;
const HEARTBEAT_STALE_MS = 30_000;
const UNKNOWN_STABLE_REQUIRED = 2; // consecutive polls with same content before treating unknown as ready

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash;
}

// Role-based intervals for 'reduced' profile (ms)
const POLL_INTERVALS: Record<string, number> = {
  worker: 2_000,
  leader: 5_000,
  boss:   10_000,
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
export function getPollingInterval(role?: AgentRole | string, lastActivityMs?: number): number {
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
}

export class PaneQueue {
  private queue: QueueEntry[] = [];
  private processing = false;
  readonly target: string;
  private lockPromise: Promise<void> = Promise.resolve();
  private role?: AgentRole | string;
  private lastActivityMs?: number;

  constructor(target: string, options?: PaneQueueOptions) {
    this.target = target;
    this.role = options?.role;
    this.lastActivityMs = options?.lastActivityMs;
  }

  /** Update agent metadata so interval calculations stay current. */
  updateOptions(options: PaneQueueOptions): void {
    if (options.role !== undefined) this.role = options.role;
    if (options.lastActivityMs !== undefined) this.lastActivityMs = options.lastActivityMs;
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
        await this.withLock(() => this.deliver(entry.item));
        entry.resolve();
      } catch (err) {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    this.processing = false;
  }

  private async waitForReady(): Promise<void> {
    const start = Date.now();
    let lastHash = 0;
    let stableCount = 0;
    while (Date.now() - start < MAX_WAIT_MS) {
      const output = await capturePane(this.target);
      if (output !== null) {
        const status = matchStatusLine(output);
        if (status === 'idle') return;
        if (status === 'unknown') {
          const currentHash = simpleHash(output);
          if (currentHash === lastHash) {
            stableCount++;
            if (stableCount >= UNKNOWN_STABLE_REQUIRED) return; // content stable — ready
          } else {
            stableCount = 0;
            lastHash = currentHash;
          }
        } else {
          // 'busy' — reset stability tracking and keep polling
          stableCount = 0;
          lastHash = 0;
        }
      }
      await Bun.sleep(getPollingInterval(this.role, this.lastActivityMs));
    }
    // Timeout — deliver anyway (best effort)
  }

  private async deliver(item: QueueItem): Promise<void> {
    // Check if pane still exists before delivery
    if (!await paneExists(this.target)) {
      logServer('WARN', `pane-queue: pane ${this.target} is dead, skipping delivery`);
      throw new Error(`pane ${this.target} no longer exists`);
    }

    switch (item.type) {
      case 'paste': {
        const r = await sendKeys(this.target, item.text);
        if (!r.delivered) throw new Error(r.error ?? 'paste delivery failed');
        break;
      }
      case 'escape': {
        const r = await sendEscape(this.target);
        if (!r.delivered) throw new Error(r.error ?? 'escape delivery failed');
        break;
      }
      case 'clear': {
        const r = await sendClear(this.target);
        if (!r.delivered) throw new Error(r.error ?? 'clear delivery failed');
        break;
      }
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    // Async mutex: wait for any prior lock holder to finish, then run exclusively
    const prev = this.lockPromise;
    let releaseLock: () => void;
    this.lockPromise = new Promise<void>(resolve => { releaseLock = resolve; });
    await prev;
    try {
      return await fn();
    } finally {
      releaseLock!();
    }
  }
}

const queues = new Map<string, PaneQueue>();

export function getQueue(target: string, options?: PaneQueueOptions): PaneQueue {
  let q = queues.get(target);
  if (!q) {
    q = new PaneQueue(target, options);
    queues.set(target, q);
  } else if (options) {
    q.updateOptions(options);
  }
  return q;
}
