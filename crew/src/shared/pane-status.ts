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
  typingActive: boolean;
  inputChars: number;
}

const MIN_CHARS_NUM = 4;

export interface PaneInputSection {
  typingActive: boolean;
  inputChars: number;
  sanitized: string;
}

export function parsePaneInputSection(
  text: string,
  paneWidth?: number,
): PaneInputSection {
  const lines = text.split('\n');
  const width = paneWidth ?? Math.max(...lines.map((l) => l.length), 0);
  const minSep = Math.max(8, Math.floor(width * 0.35));

  const sepIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.match(/─+/g) ?? [];
    const maxRun = m.reduce((acc, s) => Math.max(acc, s.length), 0);
    if (maxRun >= minSep) sepIndexes.push(i);
  }

  if (sepIndexes.length < 2) {
    return { typingActive: false, inputChars: 0, sanitized: text };
  }

  const top = sepIndexes[sepIndexes.length - 2]!;
  const bottom = sepIndexes[sepIndexes.length - 1]!;
  if (bottom <= top) {
    return { typingActive: false, inputChars: 0, sanitized: text };
  }

  const between = lines.slice(top + 1, bottom).join('\n').replace(/ /g, ' ');
  const inputChars = between.replace(/\s+/g, '').length;
  const typingActive = inputChars >= MIN_CHARS_NUM;
  const sanitized = lines.slice(0, top).join('\n');

  return { typingActive, inputChars, sanitized };
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

  if (textOutput === null)
    return {
      status: 'unknown',
      contentChanged: false,
      typingActive: false,
      inputChars: 0,
    };

  const paneMeta = await Bun.spawn(
    ['tmux', 'display-message', '-p', '-t', target, '#{pane_width}'],
    { stdout: 'pipe', stderr: 'pipe' },
  ).stdout.text();
  const paneWidth = Number.parseInt(paneMeta.trim(), 10);
  const parsed = parsePaneInputSection(
    textOutput,
    Number.isFinite(paneWidth) ? paneWidth : undefined,
  );

  const now = Date.now();
  const textHash = simpleHash(parsed.sanitized);
  const ansiHash = simpleHash(ansiOutput ?? '');
  const prev = snapshots.get(target);

  // First call — establish baseline, no comparison possible yet
  if (!prev) {
    snapshots.set(target, { textHash, ansiHash, changedAt: now });
    return {
      status: 'unknown',
      contentChanged: false,
      typingActive: parsed.typingActive,
      inputChars: parsed.inputChars,
    };
  }

  // Check if either text or ANSI changed
  const textChanged = textHash !== prev.textHash;
  const ansiChanged = ansiHash !== prev.ansiHash;
  const anyChanged = textChanged || ansiChanged;

  if (anyChanged) {
    snapshots.set(target, { textHash, ansiHash, changedAt: now });
    return {
      status: 'busy',
      contentChanged: true,
      typingActive: parsed.typingActive,
      inputChars: parsed.inputChars,
    };
  }

  // Both unchanged — check how long they've been stable
  const stableMs = now - prev.changedAt;

  if (stableMs >= STABLE_THRESHOLD_MS) {
    return {
      status: 'idle',
      contentChanged: false,
      typingActive: parsed.typingActive,
      inputChars: parsed.inputChars,
    };
  }

  // Stable but not long enough — check if agent process is even running.
  // If the process already exited (back to shell prompt), it's idle immediately.
  const agentRunning = await paneCommandLooksAlive(target);
  if (!agentRunning) {
    return {
      status: 'idle',
      contentChanged: false,
      typingActive: parsed.typingActive,
      inputChars: parsed.inputChars,
    };
  }

  // Process running, content hasn't changed long enough to be sure
  return {
    status: 'unknown',
    contentChanged: false,
    typingActive: parsed.typingActive,
    inputChars: parsed.inputChars,
  };
}

/** Remove cached snapshot when agent leaves or pane is recycled. */
export function clearPaneSnapshot(target: string): void {
  snapshots.delete(target);
}
