import { capturePane, paneCommandLooksAlive } from '../tmux/index.ts';

// Content must be unchanged for this long before we declare idle
const STABLE_THRESHOLD_MS = 3000;

interface PaneSnapshot {
  hash: number;
  changedAt: number; // epoch ms when content last changed
}

const snapshots = new Map<string, PaneSnapshot>();

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash;
}

export type PaneStatus = 'idle' | 'busy' | 'unknown';

export interface PaneStatusResult {
  status: PaneStatus;
  contentChanged: boolean; // true if content changed since last check (for last_activity updates)
}

/**
 * Determines pane status using content hash change detection + agent process check.
 *
 * Logic:
 *   - Content changed since last check → busy
 *   - Content stable >= STABLE_THRESHOLD_MS → idle
 *   - Content stable < threshold but no agent process → idle (agent exited)
 *   - No prior snapshot → unknown (call again after a moment)
 */
export async function getPaneStatus(target: string): Promise<PaneStatusResult> {
  const output = await capturePane(target);
  if (output === null) return { status: 'unknown', contentChanged: false };

  const now = Date.now();
  const currentHash = simpleHash(output);
  const prev = snapshots.get(target);

  // First call — establish baseline, no comparison possible yet
  if (!prev) {
    snapshots.set(target, { hash: currentHash, changedAt: now });
    return { status: 'unknown', contentChanged: false };
  }

  // Content changed → busy, update snapshot with new changedAt
  if (currentHash !== prev.hash) {
    snapshots.set(target, { hash: currentHash, changedAt: now });
    return { status: 'busy', contentChanged: true };
  }

  // Content unchanged — check how long it's been stable
  const stableMs = now - prev.changedAt;

  if (stableMs >= STABLE_THRESHOLD_MS) {
    return { status: 'idle', contentChanged: false };
  }

  // Stable but not long enough — check if agent process is even running.
  // If the process already exited (back to shell prompt), it's idle immediately.
  const agentRunning = await paneCommandLooksAlive(target);
  if (!agentRunning) {
    return { status: 'idle', contentChanged: false };
  }

  // Process running, content hasn't changed long enough to be sure
  return { status: 'unknown', contentChanged: false };
}

/** Remove cached snapshot when agent leaves or pane is recycled. */
export function clearPaneSnapshot(target: string): void {
  snapshots.delete(target);
}
