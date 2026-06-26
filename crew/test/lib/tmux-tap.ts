/**
 * tmux I/O Tap — recording layer + assertion helpers for tmux operations.
 * The fixture-runner mocks the tmux module via mock.module and records
 * calls into a shared log. TmuxTap provides query + assertion helpers.
 */

export interface TapEntry {
  ts: number;
  op: string;
  target?: string;
  args?: unknown[];
  result?: unknown;
  error?: string;
}

export type FaultSpec =
  | { type: 'error'; error: string }
  | { type: 'timeout' }
  | { type: 'partial'; step: 'load-buffer' | 'paste-buffer' | 'enter' };

export class TmuxTap {
  readonly log: TapEntry[] = [];
  private faults: Map<string, FaultSpec[]> = new Map();

  reset(): void {
    this.log.length = 0;
    this.faults.clear();
  }

  injectFault(op: string, fault: FaultSpec): void {
    const existing = this.faults.get(op) ?? [];
    existing.push(fault);
    this.faults.set(op, existing);
  }

  consumeFault(op: string): FaultSpec | undefined {
    const queue = this.faults.get(op);
    if (!queue || queue.length === 0) return undefined;
    return queue.shift();
  }

  getOps(op: string): TapEntry[] {
    return this.log.filter((e) => e.op === op);
  }

  getSendsTo(target: string): TapEntry[] {
    return this.log.filter(
      (e) => e.target === target && e.op.startsWith('send'),
    );
  }

  assertSent(target: string, pattern: string | RegExp): TapEntry {
    const sends = this.log.filter(
      (e) => e.op === 'sendKeys' && e.target === target,
    );
    const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    const match = sends.find((e) => {
      const text = Array.isArray(e.args) ? String(e.args[0]) : '';
      return re.test(text);
    });
    if (!match) {
      const texts = sends.map((e) =>
        Array.isArray(e.args) ? String(e.args[0]).slice(0, 80) : '(no args)',
      );
      throw new Error(
        `No sendKeys to ${target} matching ${pattern}\nSent: ${JSON.stringify(texts, null, 2)}`,
      );
    }
    return match;
  }

  assertNotSent(target: string, pattern: string | RegExp): void {
    try {
      this.assertSent(target, pattern);
    } catch {
      return;
    }
    throw new Error(`Unexpected sendKeys to ${target} matching ${pattern}`);
  }

  assertEmpty(): void {
    if (this.log.length > 0) {
      throw new Error(
        `Expected no tmux operations but got ${this.log.length}: ${this.log.map((e) => e.op).join(', ')}`,
      );
    }
  }

  toJsonl(): string {
    return this.log.map((e) => JSON.stringify(e)).join('\n');
  }
}
