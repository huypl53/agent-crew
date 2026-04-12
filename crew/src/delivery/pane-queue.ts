import { sendKeys, sendEscape, sendClear, capturePane } from '../tmux/index.ts';
import { matchStatusLine } from '../shared/status-patterns.ts';

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
const POLL_INTERVAL_MS = 500;

export class PaneQueue {
  private queue: QueueEntry[] = [];
  private processing = false;
  readonly target: string;
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(target: string) {
    this.target = target;
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
    while (Date.now() - start < MAX_WAIT_MS) {
      const output = await capturePane(this.target);
      if (output !== null) {
        const status = matchStatusLine(output);
        if (status !== 'busy') return; // idle or unknown (non-CC pane) — ready
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    // Timeout — deliver anyway (best effort)
  }

  private async deliver(item: QueueItem): Promise<void> {
    switch (item.type) {
      case 'paste':
        await sendKeys(this.target, item.text);
        break;
      case 'escape':
        await sendEscape(this.target);
        break;
      case 'clear':
        await sendClear(this.target);
        break;
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

export function getQueue(target: string): PaneQueue {
  let q = queues.get(target);
  if (!q) {
    q = new PaneQueue(target);
    queues.set(target, q);
  }
  return q;
}
