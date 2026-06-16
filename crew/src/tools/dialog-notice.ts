import type { DialogQuestion, LeaderDialogType } from '../shared/types.ts';

export interface ExtractedDialog {
  dialogType: LeaderDialogType;
  toolName: string;
  questions: DialogQuestion[] | null;
}

/**
 * Inspect a PermissionRequest payload and return dialog metadata when it is an
 * AskUserQuestion or ExitPlanMode tool call (the two decision points routed to
 * the leader). Returns null for ordinary permission requests.
 */
export function extractDialogFromPermission(
  payload: Record<string, unknown>,
): ExtractedDialog | null {
  const toolName =
    typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (toolName !== 'AskUserQuestion' && toolName !== 'ExitPlanMode') {
    return null;
  }

  const dialogType: LeaderDialogType =
    toolName === 'ExitPlanMode' ? 'plan_approval' : 'ask_question';
  if (dialogType === 'ask_question') {
    // A question-less AskUserQuestion is not actionable by the leader (nothing
    // to pick) — skip recording/notify rather than interrupt for a dead dialog.
    const questions = parseQuestions(payload.tool_input);
    if (!questions) return null;
    return { dialogType, toolName, questions };
  }
  return { dialogType, toolName, questions: null };
}

function parseQuestions(toolInput: unknown): DialogQuestion[] | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const raw = (toolInput as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) return null;

  const out: DialogQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const obj = q as Record<string, unknown>;
    const options = Array.isArray(obj.options) ? obj.options : [];
    out.push({
      question: String(obj.question ?? ''),
      header: String(obj.header ?? ''),
      multiSelect: obj.multiSelect === true,
      options: options.map((o) => {
        const opt = (o ?? {}) as Record<string, unknown>;
        return {
          label: String(opt.label ?? ''),
          description:
            typeof opt.description === 'string' ? opt.description : undefined,
          preview:
            typeof opt.preview === 'string' ? opt.preview : undefined,
        };
      }),
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * Format the immediate-interrupt notice that is sendKeys'd into the leader
 * pane the moment a worker dialog fires. The text doubles as guidance for the
 * leader agent on which crew command answers the dialog.
 */
export function formatLeaderNotice(args: {
  workerName: string;
  dialogType: LeaderDialogType;
  questions: DialogQuestion[] | null;
}): string {
  const { workerName, dialogType, questions } = args;

  if (dialogType === 'plan_approval') {
    return [
      `🔔 ${workerName} requests plan approval.`,
      `Approve: crew dialog approve ${workerName}`,
    ].join('\n');
  }

  const q = questions?.[0];
  if (!q) {
    return [
      `🔔 ${workerName} has a question pending.`,
      `Run: crew dialog pending`,
    ].join('\n');
  }

  const mode = q.multiSelect ? 'multi-select' : 'single-select';
  const header = q.header || 'Question';
  const lines = [`🔔 ${workerName} asks (${header}, ${mode}):`, q.question];
  q.options.forEach((o, i) => {
    lines.push(`  [${i + 1}] ${o.label}`);
  });
  const cmd = q.multiSelect
    ? `crew dialog answer ${workerName} --pick 1,2,…`
    : `crew dialog answer ${workerName} --pick N`;
  lines.push(`Answer: ${cmd}`);
  return lines.join('\n');
}
