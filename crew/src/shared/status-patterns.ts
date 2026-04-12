// CC status line regex patterns — empirically validated via UAT
// See: _bmad-output/test-artifacts/uat-tmux-primitives.md

// Idle: empty prompt line between separator lines
export const IDLE_PATTERN = /^❯\s*$/m;

// Busy: spinner char + verb + ellipsis + active timer
export const BUSY_PATTERN = /^[·*✶✽✻]\s+\w+…\s+\(\d/m;

// Complete: "for" (past tense) — task finished, agent idle
export const COMPLETE_PATTERN = /^✻\s+\w+\s+for\s+/m;

export type StatusMatch = 'idle' | 'busy' | 'unknown';

export function matchStatusLine(output: string): StatusMatch {
  // Check last ~20 lines for status indicators (status line is near bottom)
  const lines = output.split('\n');
  const tail = lines.slice(-20).join('\n');

  if (BUSY_PATTERN.test(tail)) return 'busy';
  if (IDLE_PATTERN.test(tail)) return 'idle';
  if (COMPLETE_PATTERN.test(tail)) return 'idle'; // complete = ready for work

  return 'unknown';
}
