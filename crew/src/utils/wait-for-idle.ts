import { capturePane } from '../tmux/index.ts';
import { extractHookCompletionMessage } from '../shared/hook-runtime.ts';
import { getAgentByPane, getLatestHookEvent } from '../state/index.ts';

export interface WaitForIdleOptions {
  target: string;
  pollInterval?: number;
  timeout?: number;
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
    h = h >>> 0;
  }
  return h;
}

function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(-n).join('\n');
}

function isCompletionHookEvent(eventType: string | null): boolean {
  return eventType === 'Stop' || eventType === 'StopFailure';
}

/**
 * Waits for a tmux pane to become idle using hook events (fast-path)
 * with tmux hash polling as fallback for unregistered panes.
 */
export async function waitForIdle(
  options: WaitForIdleOptions,
): Promise<IdleResult> {
  const { target, pollInterval = 1000, timeout = 60_000 } = options;
  const start = Date.now();
  // Subtract 1s to account for SQLite datetime() truncating to whole seconds
  const startTime = new Date(start - 1000).toISOString();

  // Fast-path: try hook events (needs DB)
  let useHooks = false;
  let agentName: string | null = null;
  try {
    const { getDb, initDb } = await import('../state/db.ts');
    try { getDb(); } catch { initDb(); }
    const agent = getAgentByPane(target);
    if (agent) {
      agentName = agent.name;
      useHooks = true;
    }
  } catch {
    // DB not available — fall back to tmux polling
  }

  if (useHooks && agentName) {
    while (true) {
      const elapsed = Date.now() - start;
      if (elapsed >= timeout) {
        return { idle: false, content: '', elapsed, timedOut: true };
      }

      const stopEvent =
        getLatestHookEvent(agentName, 'Stop') ??
        getLatestHookEvent(agentName, 'StopFailure');
      // SQLite datetime('now') returns UTC without 'Z' suffix — append it for correct JS parsing
      const eventTime = stopEvent ? new Date(stopEvent.created_at + 'Z') : null;
      if (stopEvent && eventTime && eventTime >= new Date(startTime)) {
        const content = extractHookCompletionMessage(stopEvent.payload);
        if (!isCompletionHookEvent(stopEvent.event_type)) {
          continue;
        }
        return {
          idle: true,
          content,
          elapsed: Date.now() - start,
          timedOut: false,
        };
      }

      await Bun.sleep(pollInterval);
    }
  }

  // Fallback: tmux hash-based polling
  let stableStreak = 0;
  let lastHash: number | null = null;
  let lastChangeAt = Date.now();
  let lastContent = '';

  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed >= timeout) {
      return { idle: false, content: lastContent, elapsed, timedOut: true };
    }

    const raw = await capturePane(target);
    if (raw !== null) {
      const tail = tailLines(raw, 50);
      const hash = hashString(tail);
      lastContent = raw;

      if (hash === lastHash) {
        stableStreak++;
      } else {
        stableStreak = 1;
        lastHash = hash;
        lastChangeAt = Date.now();
      }

      if (stableStreak >= 3 && Date.now() - lastChangeAt >= 5000) {
        return {
          idle: true,
          content: raw,
          elapsed: Date.now() - start,
          timedOut: false,
        };
      }
    }

    await Bun.sleep(pollInterval);
  }
}
