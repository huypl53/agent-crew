import { getDb } from './db.ts';
import type {
  DialogQuestion,
  LeaderDialog,
  LeaderDialogAnswer,
  LeaderDialogStatus,
  LeaderDialogType,
} from '../shared/types.ts';

export interface CreateLeaderDialogInput {
  roomId: number;
  workerName: string;
  workerPane: string | null;
  leaderName: string | null;
  dialogType: LeaderDialogType;
  toolName: string;
  sessionId: string | null;
  questions: DialogQuestion[] | null;
  sourceHookEventId: number | null;
}

function now(): string {
  return new Date().toISOString();
}

function parseDialogType(value: unknown): LeaderDialogType {
  return value === 'plan_approval' ? 'plan_approval' : 'ask_question';
}

function parseStatus(value: unknown): LeaderDialogStatus {
  return value === 'answered' || value === 'expired' ? value : 'pending';
}

function parseQuestions(raw: string | null): DialogQuestion[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as DialogQuestion[];
  } catch {
    return null;
  }
}

function parseAnswer(raw: string | null): LeaderDialogAnswer | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LeaderDialogAnswer;
  } catch {
    return null;
  }
}

function parseQuestionAnswers(raw: string | null): number[][] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as number[][];
  } catch {
    return null;
  }
}

function ensureDialogProgressColumns(): void {
  const db = getDb();
  const cols = db
    .query('PRAGMA table_info(leader_dialogs)')
    .all() as Array<{ name: string }>;
  const hasCurrent = cols.some((c) => c.name === 'current_question_index');
  const hasAnswers = cols.some((c) => c.name === 'question_answers');
  if (!hasCurrent) {
    db.run('ALTER TABLE leader_dialogs ADD COLUMN current_question_index INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasAnswers) {
    db.run('ALTER TABLE leader_dialogs ADD COLUMN question_answers TEXT');
  }
}

function rowToDialog(row: Record<string, unknown>): LeaderDialog {
  return {
    id: row.id as number,
    room_id: row.room_id as number,
    worker_name: row.worker_name as string,
    worker_pane: (row.worker_pane as string | null) ?? null,
    leader_name: (row.leader_name as string | null) ?? null,
    dialog_type: parseDialogType(row.dialog_type),
    tool_name: row.tool_name as string,
    session_id: (row.session_id as string | null) ?? null,
    questions: parseQuestions((row.questions as string | null) ?? null),
    current_question_index:
      Number.parseInt(String(row.current_question_index ?? 0), 10) || 0,
    question_answers: parseQuestionAnswers(
      (row.question_answers as string | null) ?? null,
    ) ?? [],
    status: parseStatus(row.status),
    answer: parseAnswer((row.answer as string | null) ?? null),
    created_at: row.created_at as string,
    answered_at: (row.answered_at as string | null) ?? null,
    source_hook_event_id:
      (row.source_hook_event_id as number | null) ?? null,
  };
}

/**
 * Record a new pending dialog and expire any prior pending dialog for the same
 * worker/room (only one active decision per worker at a time).
 */
export function createLeaderDialog(
  input: CreateLeaderDialogInput,
): LeaderDialog {
  const db = getDb();
  ensureDialogProgressColumns();
  const ts = now();
  return db.transaction(() => {
    db.run(
      `UPDATE leader_dialogs
       SET status = 'expired', answered_at = ?
       WHERE worker_name = ? AND room_id = ? AND status = 'pending'`,
      [ts, input.workerName, input.roomId],
    );

    db.run(
      `INSERT INTO leader_dialogs (
         room_id, worker_name, worker_pane, leader_name, dialog_type,
         tool_name, session_id, questions, current_question_index, question_answers,
         status, answer, answered_at,
         source_hook_event_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?)`,
      [
        input.roomId,
        input.workerName,
        input.workerPane,
        input.leaderName,
        input.dialogType,
        input.toolName,
        input.sessionId,
        input.questions ? JSON.stringify(input.questions) : null,
        0,
        null,
        input.sourceHookEventId,
      ],
    );

    const id = (db.query('SELECT last_insert_rowid() AS id').get() as {
      id: number;
    }).id;
    return getDialogById(id)!;
  })();
}

export function getDialogById(id: number): LeaderDialog | null {
  const row = getDb()
    .query('SELECT * FROM leader_dialogs WHERE id = ?')
    .get(id) as Record<string, unknown> | null;
  return row ? rowToDialog(row) : null;
}

/** Newest pending dialog for a worker in a room, or null. */
export function getActiveDialogForWorker(
  workerName: string,
  roomId: number,
): LeaderDialog | null {
  const row = getDb()
    .query(
      `SELECT * FROM leader_dialogs
       WHERE worker_name = ? AND room_id = ? AND status = 'pending'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(workerName, roomId) as Record<string, unknown> | null;
  return row ? rowToDialog(row) : null;
}

export function listPendingDialogs(roomId?: number): LeaderDialog[] {
  const db = getDb();
  const rows = (
    roomId === undefined
      ? db
          .query(
            `SELECT * FROM leader_dialogs WHERE status = 'pending' ORDER BY id`,
          )
          .all()
      : db
          .query(
            `SELECT * FROM leader_dialogs WHERE room_id = ? AND status = 'pending' ORDER BY id`,
          )
          .all(roomId)
  ) as Record<string, unknown>[];
  return rows.map(rowToDialog);
}

/** Record the leader's answer and close the dialog. No-op if not pending. */
export function markDialogAnswered(
  id: number,
  answer: LeaderDialogAnswer,
): LeaderDialog | null {
  const db = getDb();
  const ts = now();
  const result = db
    .query(`SELECT status FROM leader_dialogs WHERE id = ?`)
    .get(id) as { status: LeaderDialogStatus } | null;
  if (!result || result.status !== 'pending') return null;

  db.run(
    `UPDATE leader_dialogs
     SET status = 'answered', answer = ?, answered_at = ?
     WHERE id = ? AND status = 'pending'`,
    [JSON.stringify(answer), ts, id],
  );
  return getDialogById(id);
}

/**
 * Record a step for ask_question and either advance to the next question (while
 * keeping status pending) or close the dialog when the last question is done.
 */
export function markDialogStepAnswered(
  id: number,
  questionIndex: number,
  picks: number[],
): { dialog: LeaderDialog | null; isComplete: boolean } {
  const db = getDb();
  ensureDialogProgressColumns();
  const nowTs = now();
  const row = db
    .query(
      `SELECT status, dialog_type, questions, current_question_index,
              question_answers
       FROM leader_dialogs WHERE id = ?`,
    )
    .get(id) as
    | {
        status: LeaderDialogStatus;
        dialog_type: string;
        questions: string | null;
        current_question_index: number | null;
        question_answers: string | null;
      }
    | null;

  if (
    !row ||
    row.status !== 'pending' ||
    parseDialogType(row.dialog_type) !== 'ask_question'
  ) {
    return { dialog: null, isComplete: false };
  }

  const qIndex = Number.parseInt(String(row.current_question_index ?? 0), 10) || 0;
  if (!Number.isInteger(questionIndex) || questionIndex !== qIndex) {
    return { dialog: null, isComplete: false };
  }

  const questions = parseQuestions(row.questions);
  const totalQuestions = questions ? questions.length : 0;
  if (!Number.isInteger(totalQuestions) || totalQuestions < 1) {
    return { dialog: null, isComplete: false };
  }

  const normalizedAnswers = parseQuestionAnswers(row.question_answers) ?? [];
  const answersByQuestion = [...normalizedAnswers];
  answersByQuestion[questionIndex] = picks;

  const nextIndex = questionIndex + 1;
  if (nextIndex < totalQuestions) {
    db.run(
      `UPDATE leader_dialogs
       SET current_question_index = ?, question_answers = ?
       WHERE id = ?`,
      [nextIndex, JSON.stringify(answersByQuestion), id],
    );
    return { dialog: getDialogById(id), isComplete: false };
  }

  const allPicks = answersByQuestion.flat();
  db.run(
    `UPDATE leader_dialogs
     SET status = 'answered', answer = ?, answered_at = ?,
         question_answers = ?
     WHERE id = ?`,
    [
      JSON.stringify({
        type: 'ask_question',
        picks: allPicks,
        all_picks: answersByQuestion,
      } as LeaderDialogAnswer),
      nowTs,
      JSON.stringify(answersByQuestion),
      id,
    ],
  );
  return { dialog: getDialogById(id), isComplete: true };
}
