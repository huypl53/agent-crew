import { getAgentByPane, getLatestHookEvent } from '../state/index.ts';
import type { HookEvent } from './types.ts';
import { capturePane } from '../tmux/index.ts';

export type PaneStatus = 'idle' | 'busy' | 'unknown';

export interface PaneStatusResult {
  status: PaneStatus;
  contentChanged: boolean;
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

  const top = sepIndexes[sepIndexes.length - 2];
  const bottom = sepIndexes[sepIndexes.length - 1];
  if (top === undefined || bottom === undefined) {
    return { typingActive: false, inputChars: 0, sanitized: text };
  }
  if (bottom <= top) {
    return { typingActive: false, inputChars: 0, sanitized: text };
  }

  const between = lines
    .slice(top + 1, bottom)
    .join('\n')
    .replace(/ /g, ' ');
  const inputChars = between.replace(/\s+/g, '').length;
  const typingActive = inputChars >= MIN_CHARS_NUM;
  const sanitized = lines.slice(0, top).join('\n');

  return { typingActive, inputChars, sanitized };
}

/** Cache pane→agentName lookups with 5s TTL to avoid DB thrash */
const paneCache = new Map<string, { name: string; ts: number }>();
const PANE_CACHE_TTL_MS = 5000;

/** Track last-seen hook event ID per pane to compute contentChanged accurately */
const lastSeenEventId = new Map<string, number>();

/** Cache pane width with 30s TTL — width rarely changes */
const paneWidthCache = new Map<string, { width: number; ts: number }>();
const PANE_WIDTH_CACHE_TTL_MS = 30_000;
const NO_HOOK_MAX_LINES = 80;

interface NoHookPaneState {
  hash: number;
}

const noHookState = new Map<string, NoHookPaneState>();

function hashString(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash;
}

function tailLines(text: string, lines: number): string {
  const split = text.split('\n');
  return split.slice(-lines).join('\n');
}

function resolveNoHookStatus(
  target: string,
  textOutput: string,
): {
  status: PaneStatus;
  contentChanged: boolean;
} {
  const sample = tailLines(textOutput, NO_HOOK_MAX_LINES);
  const nextHash = hashString(sample);
  const state = noHookState.get(target);

  if (!state) {
    noHookState.set(target, { hash: nextHash });
    return {
      status: 'unknown',
      contentChanged: false,
    };
  }

  if (state.hash !== nextHash) {
    noHookState.set(target, { hash: nextHash });
    return {
      status: 'unknown',
      contentChanged: true,
    };
  }

  return {
    status: 'unknown',
    contentChanged: false,
  };
}

function isCompletionHookEvent(eventType: string | null | undefined): boolean {
  return eventType === 'Stop' || eventType === 'StopFailure';
}

function getTmuxSocketArgs(): string[] {
  const socket = process.env.CREW_TMUX_SOCKET;
  return socket ? ['-L', socket] : [];
}

function getAgentNameByPane(target: string): string | null {
  const cached = paneCache.get(target);
  if (cached && Date.now() - cached.ts < PANE_CACHE_TTL_MS) {
    return cached.name;
  }
  try {
    const agent = getAgentByPane(target);
    if (!agent) {
      paneCache.delete(target);
      return null;
    }
    paneCache.set(target, { name: agent.name, ts: Date.now() });
    return agent.name;
  } catch {
    // DB not initialized — return null gracefully
    return null;
  }
}

/**
 * Determines pane status using hook events from Claude Code.
 *
 * Logic:
 *   - Agent found → query latest hook event
 *   - Stop event → idle
 *   - UserPromptSubmit event → busy
 *   - No events → unknown (hooks not yet installed)
 *   - No agent for pane → unknown
 *   - typingActive still detected via tmux input box parsing
 */
export async function getPaneStatus(target: string): Promise<PaneStatusResult> {
  const textOutput = await capturePane(target);

  if (textOutput === null) {
    return {
      status: 'unknown',
      contentChanged: false,
      typingActive: false,
      inputChars: 0,
    };
  }

  // Parse typing state from tmux (hook-independent), cache pane width
  let paneWidth: number | undefined;
  const cachedWidth = paneWidthCache.get(target);
  if (cachedWidth && Date.now() - cachedWidth.ts < PANE_WIDTH_CACHE_TTL_MS) {
    paneWidth = cachedWidth.width;
  } else {
    try {
      const paneMeta = await Bun.spawn(
        [
          'tmux',
          ...getTmuxSocketArgs(),
          'display-message',
          '-p',
          '-t',
          target,
          '#{pane_width}',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      ).stdout.text();
      const w = Number.parseInt(paneMeta.trim(), 10);
      if (Number.isFinite(w)) {
        paneWidth = w;
        paneWidthCache.set(target, { width: w, ts: Date.now() });
      }
    } catch {
      // tmux failed — proceed without width
    }
  }
  const parsed = parsePaneInputSection(textOutput, paneWidth);

  // Resolve agent from pane target
  const agentName = getAgentNameByPane(target);
  if (!agentName) {
    noHookState.delete(target);
    return {
      status: 'unknown',
      contentChanged: false,
      typingActive: parsed.typingActive,
      inputChars: parsed.inputChars,
    };
  }

  // Derive status from latest hook event
  let latestEvent: HookEvent | null;
  try {
    latestEvent = getLatestHookEvent(agentName);
  } catch {
    paneCache.delete(target);
    lastSeenEventId.delete(target);
    noHookState.delete(target);
    return {
      status: 'unknown',
      contentChanged: false,
      typingActive: parsed.typingActive,
      inputChars: parsed.inputChars,
    };
  }
  if (!latestEvent) {
    const fallback = resolveNoHookStatus(target, textOutput);
    return {
      status: fallback.status,
      contentChanged: fallback.contentChanged,
      typingActive: parsed.typingActive,
      inputChars: parsed.inputChars,
    };
  }

  const status: PaneStatus =
    isCompletionHookEvent(latestEvent.event_type) ? 'idle' : 'busy';
  const prevEventId = lastSeenEventId.get(target) ?? 0;
  const contentChanged = latestEvent.id !== prevEventId;
  noHookState.delete(target);
  lastSeenEventId.set(target, latestEvent.id);

  return {
    status,
    contentChanged,
    typingActive: parsed.typingActive,
    inputChars: parsed.inputChars,
  };
}

export function clearPaneSnapshot(target: string): void {
  paneCache.delete(target);
  lastSeenEventId.delete(target);
  paneWidthCache.delete(target);
  noHookState.delete(target);
}
