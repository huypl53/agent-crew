/**
 * Pure keystroke translator for the leader ↔ worker dialog bridge.
 *
 * Given a pending dialog's shape (type, option count, multi-select flag, and
 * the leader's 0-based picks), produce the ordered tmux key sequence that
 * drives the worker's rendered TUI to the chosen answer and submits it.
 *
 * The key map is configurable so the exact Claude Code TUI bindings can be
 * corrected empirically (see plan.md "Spec literal + validate") without
 * changing the algorithm.
 *
 * Spec (user-described) defaults:
 *   Up/Down ........ move focus
 *   Space .......... select / toggle focused option
 *   Right .......... next question or submit control in multi-select flow
 *   Enter .......... submit / advance question for single-select
 */

export interface KeyAction {
  key: string;
  repeat: number;
}

export interface DialogKeyMap {
  /** Toggle/select the focused option. */
  select: string;
  /** Move focus one step toward the submit button (Down). */
  submitNav: string;
  /** Move focus to next question / submit control in multi-question flows. */
  nextQuestion: string;
  /** Submit the dialog (Enter). */
  submit: string;
  /**
   * Single-select dialogs submit directly on the focused option via `submit`,
   * skipping the separate select + submit-navigation steps. Set false to drive
   * single-select the same way as multi-select (Space to select, then nav).
   */
  directSubmitSingle: boolean;
}

export const DEFAULT_DIALOG_KEYMAP: DialogKeyMap = {
  select: 'Space',
  submitNav: 'Down',
  nextQuestion: 'Right',
  submit: 'Enter',
  directSubmitSingle: true,
};

export interface BuildKeystrokesInput {
  dialogType: 'ask_question' | 'plan_approval';
  /** Number of options in the question (ask_question only). */
  optionCount: number;
  /** Whether the question allows multiple selections. */
  multiSelect: boolean;
  /** 0-based option indices the leader picked. */
  picks: number[];
  /** 0-based index of the question in the AskUserQuestion payload. */
  questionIndex: number;
  /** Total number of questions in the AskUserQuestion payload. */
  totalQuestions: number;
}

/** Flatten grouped KeyActions into a flat list of tmux key names. */
export function expandKeyActions(actions: KeyAction[]): string[] {
  const out: string[] = [];
  for (const a of actions) {
    for (let i = 0; i < Math.max(1, a.repeat); i++) out.push(a.key);
  }
  return out;
}

/** Render actions compactly for logging/display (e.g. "Down×2 Space Enter"). */
export function describeKeyActions(actions: KeyAction[]): string {
  return actions
    .map((a) => (a.repeat > 1 ? `${a.key}×${a.repeat}` : a.key))
    .join(' ');
}

function normalizePicks(picks: number[], optionCount: number): number[] {
  const valid = new Set<number>();
  for (const p of picks) {
    if (Number.isInteger(p) && p >= 0 && p < optionCount) valid.add(p);
  }
  return [...valid].sort((a, b) => a - b);
}

/**
 * Build the keystroke sequence for a dialog. Returns an empty array when the
 * dialog cannot be driven (e.g. no options).
 */
export function buildKeystrokes(
  input: BuildKeystrokesInput,
  keymap: DialogKeyMap = DEFAULT_DIALOG_KEYMAP,
): KeyAction[] {
  if (input.dialogType === 'plan_approval') {
    return [{ key: keymap.submit, repeat: 1 }];
  }

  const optionCount = input.optionCount;
  if (!Number.isInteger(optionCount) || optionCount < 1) return [];

  const totalQuestions = input.totalQuestions > 1 ? input.totalQuestions : 1;
  const questionIndex = input.questionIndex > 0 ? input.questionIndex : 0;
  const isLastQuestion = questionIndex >= totalQuestions - 1;

  const picks = normalizePicks(input.picks, optionCount);

  // Single-select short-circuit: focus the option, Enter moves to next question
  // or submits final question.
  if (!input.multiSelect && keymap.directSubmitSingle) {
    const target = picks[0] ?? 0;
    const actions: KeyAction[] = [];
    if (target > 0) actions.push({ key: keymap.submitNav, repeat: target });
    actions.push({ key: keymap.submit, repeat: 1 });
    return actions;
  }

  // General path (multi-select, or single-select driven like multi-select):
  // walk focus down to each picked option and toggle it.
  const actions: KeyAction[] = [];
  let pos = 0;
  for (const pick of picks) {
    const steps = pick - pos;
    if (steps > 0) actions.push({ key: keymap.submitNav, repeat: steps });
    actions.push({ key: keymap.select, repeat: 1 });
    pos = pick;
  }

  // Non-final questions move to the next question with Right after picking.
  if (!isLastQuestion) {
    actions.push({ key: keymap.nextQuestion, repeat: 1 });
    return actions;
  }

  // Final question: move from options area to submit control, then submit.
  actions.push({ key: keymap.nextQuestion, repeat: 1 });
  actions.push({ key: keymap.submit, repeat: 1 });
  return actions;
}
