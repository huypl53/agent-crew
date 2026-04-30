import {
  capturePane,
  capturePaneWithAnsi,
  paneCommandLooksAlive,
} from '../tmux/index.ts';

// Content must be unchanged for this long before we declare idle
const STABLE_THRESHOLD_MS = 3000;
// Number of lines to check for ANSI changes (status region)
const ANSI_CHECK_LINES = 8;

interface PaneSnapshot {
  textHash: number;
  ansiHash: number; // hash of last N lines with ANSI codes (catches color-only changes)
  changedAt: number; // epoch ms when content last changed
}

const snapshots = new Map<string, PaneSnapshot>();

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
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
 *   - Text OR ANSI changed since last check → busy
 *   - Both stable >= STABLE_THRESHOLD_MS → idle
 *   - Both stable < threshold but no agent process → idle (agent exited)
 *   - No prior snapshot → unknown (call again after a moment)
 *
 * ANSI detection catches "thinking" states where Claude Code shows color
 * changes (status line animation) but no text output yet.
 */
export async function getPaneStatus(target: string): Promise<PaneStatusResult> {
  const [textOutput, ansiOutput] = await Promise.all([
    capturePane(target),
    capturePaneWithAnsi(target, ANSI_CHECK_LINES),
  ]);

  if (textOutput === null) return { status: 'unknown', contentChanged: false };

  const now = Date.now();
  const textHash = simpleHash(textOutput);
  const ansiHash = simpleHash(ansiOutput ?? '');
  const prev = snapshots.get(target);

  // First call — establish baseline, no comparison possible yet
  if (!prev) {
    snapshots.set(target, { textHash, ansiHash, changedAt: now });
    return { status: 'unknown', contentChanged: false };
  }

  // Check if either text or ANSI changed
  const textChanged = textHash !== prev.textHash;
  const ansiChanged = ansiHash !== prev.ansiHash;
  const anyChanged = textChanged || ansiChanged;

  if (anyChanged) {
    snapshots.set(target, { textHash, ansiHash, changedAt: now });
    return { status: 'busy', contentChanged: true };
  }

  // Both unchanged — check how long they've been stable
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
