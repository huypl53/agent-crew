import { initDb } from '../state/db.ts';
import {
  getActiveDialogForWorker,
  getAgentByPane,
  getAgentByRoomAndName,
  getRoom,
  listPendingDialogs,
  markDialogAnswered,
} from '../state/index.ts';
import { logServer } from '../shared/server-log.ts';
import type { LeaderDialog, ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { capturePaneTail, sendKey } from '../tmux/index.ts';
import {
  buildKeystrokes,
  describeKeyActions,
  expandKeyActions,
} from './dialog-keystrokes.ts';

interface ResolvedRoom {
  roomId: number;
  roomName: string;
}

/** Resolve the target room from --room, else the caller's registered pane. */
function resolveRoom(room?: string): ResolvedRoom | { error: string } {
  if (room) {
    const r = getRoom(room);
    if (!r) return { error: `Room not found: ${room}` };
    return { roomId: r.id, roomName: r.name };
  }
  const pane = process.env.TMUX_PANE;
  const paneAgent = pane ? getAgentByPane(pane) : undefined;
  if (paneAgent) {
    return { roomId: paneAgent.room_id, roomName: paneAgent.room_name };
  }
  return {
    error:
      'No room specified and current pane is not a registered agent. Pass --room <name>.',
  };
}

/** Parse a 1-based pick spec ("1,3" or ["1","3"]) into 1-based numbers. */
function parsePicks(raw: string | string[] | undefined): number[] {
  if (!raw) return [];
  const parts = Array.isArray(raw) ? raw : String(raw).split(',');
  const picks: number[] = [];
  for (const p of parts) {
    const n = parseInt(String(p).trim(), 10);
    if (Number.isInteger(n)) picks.push(n);
  }
  return picks;
}

function serializeDialog(d: LeaderDialog) {
  const q = d.questions?.[0];
  return {
    id: d.id,
    worker: d.worker_name,
    type: d.dialog_type,
    tool: d.tool_name,
    question: q?.question ?? null,
    header: q?.header ?? null,
    multi_select: q?.multiSelect ?? false,
    options: (q?.options ?? []).map((o, i) => ({ n: i + 1, label: o.label })),
    created_at: d.created_at,
  };
}

/** List pending dialogs in the caller's room (or --room). */
export async function handleDialogPending(params: {
  room?: string;
}): Promise<ToolResult> {
  initDb();
  const resolved = resolveRoom(params.room);
  if ('error' in resolved) return err(resolved.error);
  const dialogs = listPendingDialogs(resolved.roomId).map(serializeDialog);
  return ok({ ok: true, room: resolved.roomName, dialogs });
}

/** Answer a worker's AskUserQuestion by driving its pane. */
export async function handleDialogAnswer(params: {
  worker?: string;
  room?: string;
  pick?: string | string[];
}): Promise<ToolResult> {
  initDb();
  const worker = params.worker?.trim();
  if (!worker) {
    return err(
      'Worker name required: crew dialog answer <worker> --pick N[,M]',
    );
  }
  const resolved = resolveRoom(params.room);
  if ('error' in resolved) return err(resolved.error);

  const agent = getAgentByRoomAndName(resolved.roomId, worker);
  if (!agent?.tmux_target) {
    return err(
      `Worker ${worker} has no registered tmux pane in ${resolved.roomName}`,
    );
  }

  const dialog = getActiveDialogForWorker(worker, resolved.roomId);
  if (!dialog) {
    return err(`No pending dialog for ${worker} in ${resolved.roomName}`);
  }
  if (dialog.dialog_type !== 'ask_question') {
    return err(
      `Dialog #${dialog.id} is a plan approval — use 'crew dialog approve ${worker}'`,
    );
  }
  const q = dialog.questions?.[0];
  if (!q || q.options.length === 0) {
    return err(`Dialog #${dialog.id} has no options to pick`);
  }

  const picks1 = parsePicks(params.pick);
  if (picks1.length === 0) {
    return err(
      'No picks given. Use --pick N (1-based): --pick 2  or  --pick 1,3',
    );
  }
  const picks0 = [...new Set(picks1.map((p) => p - 1))].sort((a, b) => a - b);
  const bad = picks0.find((p) => p < 0 || p >= q.options.length);
  if (bad !== undefined) {
    return err(`Pick ${bad + 1} is out of range (valid: 1..${q.options.length})`);
  }
  if (!q.multiSelect && picks0.length > 1) {
    return err(
      `Dialog #${dialog.id} is single-select — provide exactly one --pick`,
    );
  }

  // Stale-dialog guard: confirm the first option's label is visible on the
  // pane before driving it. Fail-open if the capture itself errors.
  const label = q.options[0].label;
  const pane = await capturePaneTail(agent.tmux_target, 40);
  if (pane !== null && label && !pane.includes(label)) {
    logServer(
      'WARN',
      `[dialog:answer] #${dialog.id} option "${label}" not visible on ${worker} — likely stale`,
    );
    return err(
      `Dialog not visible on ${worker}'s pane (option "${label}" not found). It may have been dismissed.`,
    );
  }

  const actions = buildKeystrokes({
    dialogType: 'ask_question',
    optionCount: q.options.length,
    multiSelect: q.multiSelect,
    picks: picks0,
  });
  const keys = expandKeyActions(actions);
  for (const key of keys) {
    const r = await sendKey(agent.tmux_target, key);
    if (!r.delivered) {
      return err(
        `Failed to send key "${key}" to ${worker}: ${r.error ?? 'unknown'}`,
      );
    }
  }

  markDialogAnswered(dialog.id, { type: 'ask_question', picks: picks0 });
  return ok({
    ok: true,
    worker,
    dialog_id: dialog.id,
    picks: picks0.map((p) => p + 1),
    keys: describeKeyActions(actions),
  });
}

/** Approve a worker's ExitPlanMode plan-approval dialog (Enter). */
export async function handleDialogApprove(params: {
  worker?: string;
  room?: string;
}): Promise<ToolResult> {
  initDb();
  const worker = params.worker?.trim();
  if (!worker) {
    return err('Worker name required: crew dialog approve <worker>');
  }
  const resolved = resolveRoom(params.room);
  if ('error' in resolved) return err(resolved.error);

  const agent = getAgentByRoomAndName(resolved.roomId, worker);
  if (!agent?.tmux_target) {
    return err(
      `Worker ${worker} has no registered tmux pane in ${resolved.roomName}`,
    );
  }

  const dialog = getActiveDialogForWorker(worker, resolved.roomId);
  if (!dialog) {
    return err(`No pending dialog for ${worker} in ${resolved.roomName}`);
  }
  if (dialog.dialog_type !== 'plan_approval') {
    return err(
      `Dialog #${dialog.id} is a question — use 'crew dialog answer ${worker} --pick N'`,
    );
  }

  const r = await sendKey(agent.tmux_target, 'Enter');
  if (!r.delivered) {
    return err(`Failed to send Enter to ${worker}: ${r.error ?? 'unknown'}`);
  }
  markDialogAnswered(dialog.id, { type: 'plan_approval', approved: true });
  return ok({ ok: true, worker, dialog_id: dialog.id, approved: true });
}
