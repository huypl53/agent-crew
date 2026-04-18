// Status line regex patterns for Claude Code and Codex CLI
// See: _bmad-output/test-artifacts/uat-tmux-primitives.md

// === Claude Code patterns ===
// Idle: empty prompt line (❯)
export const CC_IDLE_PATTERN = /^❯\s*$/m;
// Busy: spinner char + action text + ellipsis + active timer
export const CC_BUSY_PATTERN = /^[·*✶✽✻✳]\s+.+…\s+\(\d/m;
// Complete: "for" (past tense) — task finished
export const CC_COMPLETE_PATTERN = /^✻\s+\w+\s+for\s+/m;

// === Codex CLI patterns ===
// Idle: › prompt with model line visible (gpt-*-codex or o3/o4)
export const CODEX_IDLE_PATTERN =
  /^›\s+.*\n\n\s+gpt-.*-codex|^›\s+.*\n\n\s+o[34]/m;
// Busy: • action indicator (Codex shows • for tool calls/actions)
export const CODEX_BUSY_PATTERN =
  /^•\s+(?:Running|Reading|Writing|Editing|Searching)/m;

export type StatusMatch = 'idle' | 'busy' | 'unknown';

export function matchStatusLine(output: string): StatusMatch {
  // Check last ~20 lines for status indicators (status line is near bottom)
  const lines = output.split('\n');
  const tail = lines.slice(-20).join('\n');

  // Check busy patterns first (higher priority)
  if (CC_BUSY_PATTERN.test(tail)) return 'busy';
  if (CODEX_BUSY_PATTERN.test(tail)) return 'busy';

  // Check idle patterns
  if (CC_IDLE_PATTERN.test(tail)) return 'idle';
  if (CC_COMPLETE_PATTERN.test(tail)) return 'idle';
  if (CODEX_IDLE_PATTERN.test(tail)) return 'idle';

  return 'unknown';
}
