import { capturePane } from '../tmux/index.ts';

export interface WaitForIdleOptions {
  target: string;        // tmux pane target (e.g. "%5" or "session:0.1")
  stableCount?: number;  // consecutive identical-hash polls needed (default: 3)
  idleSeconds?: number;  // seconds content must be unchanged (default: 5)
  pollInterval?: number; // ms between polls (default: 1000)
  timeout?: number;      // max wait ms (default: 60000)
  lines?: number;        // tail lines to hash (default: 50)
}

export interface IdleResult {
  idle: boolean;
  content: string;
  elapsed: number;
  timedOut: boolean;
}

/** djb2-style hash — fast, good distribution for terminal content */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h;
}

function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(-n).join('\n');
}

/**
 * Polls a tmux pane until its content is stable (unchanged hash) for
 * `stableCount` consecutive polls AND `idleSeconds` wall-clock seconds.
 *
 * Returns immediately with timedOut=true if `timeout` ms elapses.
 */
export async function waitForIdle(options: WaitForIdleOptions): Promise<IdleResult> {
  const {
    target,
    stableCount = 3,
    idleSeconds = 5,
    pollInterval = 1000,
    timeout = 60_000,
    lines = 50,
  } = options;

  const start = Date.now();
  let stableStreak = 0;
  let lastHash: number | null = null;
  let lastChangeAt = start;
  let lastContent = '';

  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed >= timeout) {
      return { idle: false, content: lastContent, elapsed, timedOut: true };
    }

    const raw = await capturePane(target);
    if (raw !== null) {
      const tail = tailLines(raw, lines);
      const hash = hashString(tail);
      lastContent = raw;

      if (hash === lastHash) {
        stableStreak++;
      } else {
        stableStreak = 1;
        lastHash = hash;
        lastChangeAt = Date.now();
      }

      const stableMs = Date.now() - lastChangeAt;
      const stableEnough = stableStreak >= stableCount && stableMs >= idleSeconds * 1000;

      if (stableEnough) {
        return { idle: true, content: raw, elapsed: Date.now() - start, timedOut: false };
      }
    }

    await Bun.sleep(pollInterval);
  }
}
