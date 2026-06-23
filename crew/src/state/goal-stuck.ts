/**
 * Goal stuck detector — pure functions (no DB).
 *
 * Detects a tight rhythmic loop of near-identical completion outputs, the
 * signature of a weak-LLM agent looping on the goal reminder without ever
 * running `crew goal done`.
 *
 * Confirmed against fixtures in test/goal-stuck-detector.test.ts.
 */

/** Normalize a completion message: strip loop-noise before comparison. */
export function normalizeGoalMessage(raw: string): string {
  let s = raw ?? '';
  for (const re of REMINDER_NOISE) s = s.replace(re, ' ');
  s = s.toLowerCase();
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' '); // keep word chars only
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Noise patterns stripped during normalization. Agents (esp. weak LLMs) echo
// the injected reminder template back; without stripping it, every turn looks
// near-identical even when real work happened.
const REMINDER_NOISE = [
  /🎯[\s\S]*?turn \d+/gi, // "🎯 Goal: … (turn N)"
  /✅[\s\S]*?crew goal done/gi,
  /❌[\s\S]*?crew goal unset/gi,
  /📝[\s\S]*?crew goal update[\s\S]*?/gi,
  /crew[:_]?(worker|leader)/gi, // skill tokens: crew:worker / crew_worker
  /\bcrew goal (done|unset|update)[^\n]*/gi, // bare command echoes
  /\bturn ?\d+\b/gi, // turn counters
  /\b\d{1,2}:\d{2}(:\d{2})?\b/g, // clock times
  /\b\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}/gi, // ISO timestamps
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2705}\u{274C}\u{1F4DD}]/gu, // emoji + symbols
];

function tokens(s: string): Set<string> {
  return new Set(normalizeGoalMessage(s).split(' ').filter(Boolean));
}

/** Jaccard similarity on normalized token sets, 0..1. */
export function goalMessageSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  // Empty payloads carry no signal (e.g. leader Stop in minimal fixtures, or a
  // worker stop with no assistant message). We cannot conclude "looping" from
  // emptiness, so empty-vs-anything → 0 similarity (no false stuck trip).
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export interface GoalStuckOptions {
  /** Consecutive near-identical outputs required. Default 3 (configurable). */
  window: number;
  /** Jaccard >= this counts as "near-identical". */
  simThreshold: number;
  /** All inter-turn gaps must be <= this (tight loop). */
  gapCeilingMs: number;
  /** max gap <= ratio * min gap (rhythmic). */
  gapUniformRatio: number;
}

export const STUCK_DEFAULTS: GoalStuckOptions = {
  window: 3,
  simThreshold: 0.9,
  gapCeilingMs: 120_000, // 2 min between stops
  gapUniformRatio: 3,
};

export interface GoalOutputEntry {
  /** Completion message (raw; normalized at compare time). */
  message: string;
  tsMs: number;
}

/**
 * Decide whether the rolling output window indicates a stuck loop.
 * Stuck = last `window` entries are pairwise near-identical AND their time
 * gaps are tight + rhythmic.
 */
export function isGoalStuck(
  entries: GoalOutputEntry[],
  opts: GoalStuckOptions = STUCK_DEFAULTS,
): boolean {
  if (entries.length < opts.window) return false;
  const recent = entries.slice(-opts.window);

  // Pairwise consecutive near-identical (covers progressive drift).
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const curr = recent[i];
    if (!prev || !curr) return false; // defensive; unreachable given slice
    if (goalMessageSimilarity(prev.message, curr.message) < opts.simThreshold) {
      return false;
    }
  }

  // Time gaps: tight + rhythmic.
  const gaps: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const curr = recent[i];
    if (!prev || !curr) return false; // defensive; unreachable given slice
    gaps.push(curr.tsMs - prev.tsMs);
  }
  if (gaps.some((g) => g <= 0 || g > opts.gapCeilingMs)) return false;
  const gmin = Math.min(...gaps);
  const gmax = Math.max(...gaps);
  if (gmax > gmin * opts.gapUniformRatio) return false;

  return true;
}
