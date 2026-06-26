import type {
  MessageBatch,
  MessageBatchStatus,
  MessageBatchWorker,
  MessageBatchWorkerDispatchStatus,
  MessageBatchWorkerTerminalOutcome,
  MessageBatchWorkerTerminalStatus,
} from '../shared/types.ts';
import { getDb } from './db.ts';

export interface CreateMessageBatchInput {
  batchId: string;
  roomId: number;
  leaderName: string;
  hintAfterSeconds: number | null;
  workers: Array<{ workerName: string; promptFile: string }>;
}

function now(): string {
  return new Date().toISOString();
}

function requireTrimmed(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || Math.floor(value) !== value) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requireNullablePositiveInteger(
  value: number | null,
  label: string,
): number | null {
  if (value === null) return null;
  return requirePositiveInteger(value, label);
}

function parseBatchStatus(value: unknown): MessageBatchStatus {
  return value === 'completed' ? 'completed' : 'running';
}

function parseDispatchStatus(value: unknown): MessageBatchWorkerDispatchStatus {
  return value === 'sent' || value === 'failed' ? value : 'pending';
}

function parseTerminalStatus(value: unknown): MessageBatchWorkerTerminalStatus {
  return value === 'success' || value === 'interrupted' ? value : 'running';
}

function rowToBatch(row: Record<string, unknown>): MessageBatch {
  return {
    id: row.id as number,
    batch_id: row.batch_id as string,
    room_id: row.room_id as number,
    leader_name: row.leader_name as string,
    status: parseBatchStatus(row.status),
    hint_after_seconds: (row.hint_after_seconds as number | null) ?? null,
    hint_sent_at: (row.hint_sent_at as string | null) ?? null,
    created_at: row.created_at as string,
    completed_at: (row.completed_at as string | null) ?? null,
  };
}

function rowToWorker(row: Record<string, unknown>): MessageBatchWorker {
  return {
    id: row.id as number,
    batch_id: row.batch_id as string,
    worker_name: row.worker_name as string,
    manifest_order: row.manifest_order as number,
    prompt_file: row.prompt_file as string,
    dispatch_status: parseDispatchStatus(row.dispatch_status),
    terminal_status: parseTerminalStatus(row.terminal_status),
    final_message: (row.final_message as string | null) ?? null,
    error_text: (row.error_text as string | null) ?? null,
    started_at: (row.started_at as string | null) ?? null,
    finished_at: (row.finished_at as string | null) ?? null,
  };
}

export function createMessageBatch(
  input: CreateMessageBatchInput,
): MessageBatch {
  const batchId = requireTrimmed(input.batchId, 'batchId');
  const leaderName = requireTrimmed(input.leaderName, 'leaderName');
  const roomId = requirePositiveInteger(input.roomId, 'roomId');
  const hintAfterSeconds = requireNullablePositiveInteger(
    input.hintAfterSeconds,
    'hintAfterSeconds',
  );

  if (!Array.isArray(input.workers) || input.workers.length === 0) {
    throw new Error('workers must contain at least one entry');
  }

  const workers = input.workers.map((worker, index) => ({
    workerName: requireTrimmed(
      worker.workerName,
      `workers[${index}].workerName`,
    ),
    promptFile: requireTrimmed(
      worker.promptFile,
      `workers[${index}].promptFile`,
    ),
    manifestOrder: index,
  }));

  const seen = new Set<string>();
  for (const worker of workers) {
    if (seen.has(worker.workerName)) {
      throw new Error(`Duplicate worker in batch: ${worker.workerName}`);
    }
    seen.add(worker.workerName);
  }

  const db = getDb();
  const ts = now();
  db.transaction(() => {
    db.run(
      `INSERT INTO message_batches (
         batch_id, room_id, leader_name, status, hint_after_seconds,
         hint_sent_at, created_at, completed_at
       ) VALUES (?, ?, ?, 'running', ?, NULL, ?, NULL)`,
      [batchId, roomId, leaderName, hintAfterSeconds, ts],
    );

    for (const worker of workers) {
      db.run(
        `INSERT INTO message_batch_workers (
           batch_id, worker_name, manifest_order, prompt_file,
           dispatch_status, terminal_status, final_message, error_text,
           started_at, finished_at
         ) VALUES (?, ?, ?, ?, 'pending', 'running', NULL, NULL, NULL, NULL)`,
        [batchId, worker.workerName, worker.manifestOrder, worker.promptFile],
      );
    }
  })();

  return getMessageBatch(batchId)!;
}

export function markBatchWorkerSent(batchId: string, workerName: string): void {
  const ts = now();
  getDb().run(
    `UPDATE message_batch_workers
     SET dispatch_status = 'sent', started_at = COALESCE(started_at, ?)
     WHERE batch_id = ? AND worker_name = ? AND terminal_status = 'running'`,
    [ts, batchId, workerName],
  );
}

export function markBatchWorkerDispatchFailed(
  batchId: string,
  workerName: string,
  errorText: string,
): void {
  const ts = now();
  getDb().run(
    `UPDATE message_batch_workers
     SET dispatch_status = 'failed', terminal_status = 'interrupted', error_text = ?, finished_at = ?
     WHERE batch_id = ? AND worker_name = ? AND terminal_status = 'running'`,
    [errorText.trim(), ts, batchId, workerName],
  );
}

function isTerminalOutcome(
  terminalStatus: MessageBatchWorkerTerminalStatus,
): terminalStatus is MessageBatchWorkerTerminalOutcome {
  return terminalStatus === 'success' || terminalStatus === 'interrupted';
}

export function completeBatchWorker(
  batchId: string,
  workerName: string,
  terminalStatus: MessageBatchWorkerTerminalOutcome,
  finalMessage: string,
): void {
  if (!isTerminalOutcome(terminalStatus)) {
    throw new Error(`Invalid terminal status: ${terminalStatus}`);
  }

  const ts = now();
  getDb().run(
    `UPDATE message_batch_workers
     SET dispatch_status = CASE WHEN dispatch_status = 'pending' THEN 'sent' ELSE dispatch_status END,
         terminal_status = ?,
         final_message = ?,
         finished_at = ?,
         started_at = COALESCE(started_at, ?)
     WHERE batch_id = ? AND worker_name = ? AND terminal_status = 'running'`,
    [terminalStatus, finalMessage, ts, ts, batchId, workerName],
  );
}

export function getMessageBatch(batchId: string): MessageBatch | null {
  const row = getDb()
    .query('SELECT * FROM message_batches WHERE batch_id = ?')
    .get(batchId) as Record<string, unknown> | null;
  return row ? rowToBatch(row) : null;
}

export function getBatchWorkers(batchId: string): MessageBatchWorker[] {
  return (
    getDb()
      .query(
        'SELECT * FROM message_batch_workers WHERE batch_id = ? ORDER BY manifest_order, id',
      )
      .all(batchId) as Record<string, unknown>[]
  ).map(rowToWorker);
}

export function listIncompleteBatches(nowIso: string): MessageBatch[] {
  return (
    getDb()
      .query(
        'SELECT * FROM message_batches WHERE status = ? AND created_at <= ? ORDER BY created_at, id',
      )
      .all('running', nowIso) as Record<string, unknown>[]
  ).map(rowToBatch);
}

export interface HintableBatch {
  batch_id: string;
  leader_name: string;
  room_id: number;
  worker_names: string[];
}

export function listHintableBatches(nowIso: string): HintableBatch[] {
  const rows = getDb()
    .query(
      `SELECT b.batch_id, b.leader_name, b.room_id, w.worker_name
       FROM message_batches b
       JOIN message_batch_workers w ON w.batch_id = b.batch_id
       WHERE b.status = 'running'
         AND b.completed_at IS NULL
         AND b.hint_after_seconds IS NOT NULL
         AND b.hint_after_seconds > 0
         AND b.hint_sent_at IS NULL
         AND w.terminal_status = 'running'
         AND ((julianday(?) - julianday(b.created_at)) * 86400.0) >= b.hint_after_seconds
       ORDER BY b.created_at, b.id, w.manifest_order, w.id`,
    )
    .all(nowIso) as Array<{
    batch_id: string;
    leader_name: string;
    room_id: number;
    worker_name: string;
  }>;

  const grouped = new Map<string, HintableBatch>();
  for (const row of rows) {
    const existing = grouped.get(row.batch_id);
    if (existing) {
      existing.worker_names.push(row.worker_name);
      continue;
    }
    grouped.set(row.batch_id, {
      batch_id: row.batch_id,
      leader_name: row.leader_name,
      room_id: row.room_id,
      worker_names: [row.worker_name],
    });
  }

  return Array.from(grouped.values());
}

export function renderBatchPendingHint(workerNames: string[]): string {
  return `Batch pending: ${workerNames.join(', ')}\nInspect them directly.`;
}

export function markBatchHintSent(batchId: string, sentAtIso: string): void {
  getDb().run(
    'UPDATE message_batches SET hint_sent_at = ? WHERE batch_id = ?',
    [sentAtIso, batchId],
  );
}

export function markBatchCompleted(
  batchId: string,
  completedAtIso: string,
): void {
  getDb().run(
    'UPDATE message_batches SET status = ?, completed_at = ? WHERE batch_id = ?',
    ['completed', completedAtIso, batchId],
  );
}

export function areAllBatchWorkersTerminal(batchId: string): boolean {
  const row = getDb()
    .query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN terminal_status = 'running' THEN 0 ELSE 1 END) AS done
       FROM message_batch_workers
       WHERE batch_id = ?`,
    )
    .get(batchId) as { total: number; done: number | null } | null;

  return Boolean(row && row.total > 0 && row.done === row.total);
}

function hasActiveBatchWorkerGoals(
  db: ReturnType<typeof getDb>,
  batchId: string,
): boolean {
  const row = db
    .query(
      `SELECT SUM(CASE WHEN EXISTS (
                SELECT 1
                FROM agent_goals g
                WHERE g.agent_name = w.worker_name
                  AND g.room_id = b.room_id
                  AND g.status = 'active'
              ) THEN 1 ELSE 0 END) AS active_goal_count
       FROM message_batch_workers w
       JOIN message_batches b ON b.batch_id = w.batch_id
       WHERE w.batch_id = ? AND b.status = 'running' AND b.completed_at IS NULL`,
    )
    .get(batchId) as { active_goal_count: number | null } | null;

  return (row?.active_goal_count ?? 0) > 0;
}

export function evaluateBatchFinalization(batchId: string): {
  batchId: string;
  leaderName: string;
  roomId: number;
  shouldFinalize: boolean;
} | null {
  const row = getDb()
    .query(
      `SELECT b.batch_id, b.leader_name, b.room_id
       FROM message_batches b
       WHERE b.batch_id = ? AND b.status = 'running' AND b.completed_at IS NULL`,
    )
    .get(batchId) as {
    batch_id: string;
    leader_name: string;
    room_id: number;
  } | null;

  if (!row) return null;

  const workerStatus = getDb()
    .query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN terminal_status = 'running' THEN 0 ELSE 1 END) AS done
       FROM message_batch_workers
       WHERE batch_id = ?`,
    )
    .get(batchId) as { total: number; done: number | null } | null;

  if (
    !workerStatus ||
    workerStatus.total <= 0 ||
    workerStatus.done !== workerStatus.total
  ) {
    return {
      batchId: row.batch_id,
      leaderName: row.leader_name,
      roomId: row.room_id,
      shouldFinalize: false,
    };
  }

  const hasActiveGoals = hasActiveBatchWorkerGoals(getDb(), batchId);
  if (hasActiveGoals) {
    return {
      batchId: row.batch_id,
      leaderName: row.leader_name,
      roomId: row.room_id,
      shouldFinalize: false,
    };
  }

  const ts = now();
  getDb().run(
    `UPDATE message_batches
     SET status = 'completed', completed_at = ?
     WHERE batch_id = ? AND completed_at IS NULL`,
    [ts, batchId],
  );

  return {
    batchId: row.batch_id,
    leaderName: row.leader_name,
    roomId: row.room_id,
    shouldFinalize: true,
  };
}

function shouldFinalizeBatch(
  db: ReturnType<typeof getDb>,
  batchId: string,
): boolean {
  const counts = db
    .query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN terminal_status = 'running' THEN 0 ELSE 1 END) AS done
       FROM message_batch_workers
       WHERE batch_id = ?`,
    )
    .get(batchId) as { total: number; done: number | null } | null;

  if (!counts || counts.total <= 0 || counts.done !== counts.total)
    return false;
  if (hasActiveBatchWorkerGoals(db, batchId)) return false;

  const ts = now();
  const result = db.run(
    `UPDATE message_batches
     SET status = 'completed', completed_at = ?
     WHERE batch_id = ? AND completed_at IS NULL`,
    [ts, batchId],
  );

  return result.changes > 0;
}

export interface OpenBatchForWorker {
  batchId: string;
  leaderName: string;
  roomId: number;
  createdAt: string;
}

export interface RecordedBatchWorkerTerminalMessage extends OpenBatchForWorker {
  shouldFinalize: boolean;
}

export interface LatestBatchForWorker extends OpenBatchForWorker {
  status: MessageBatchStatus;
  terminal_status: MessageBatchWorkerTerminalStatus;
  final_message: string | null;
  finished_at: string | null;
}

function rowToOpenBatch(row: Record<string, unknown>): OpenBatchForWorker {
  return {
    batchId: row.batch_id as string,
    leaderName: row.leader_name as string,
    roomId: row.room_id as number,
    createdAt: row.created_at as string,
  };
}

function getLatestPersistedBatchAssociationForWorker(
  workerName: string,
  roomId?: number,
  requireRunning = false,
): OpenBatchForWorker | null {
  const roomFilter = roomId === undefined ? '' : ' AND m.room_id = ?';
  const row = getDb()
    .query(
      `SELECT b.batch_id, b.leader_name, b.room_id, b.created_at, b.status, b.completed_at
       FROM messages m
       JOIN message_batches b ON b.batch_id = m.batch_id
       WHERE m.batch_id IS NOT NULL
         AND m.worker_name = ?
         AND m.room_id = b.room_id${roomFilter}
       ORDER BY m.id DESC
       LIMIT 1`,
    )
    .get(workerName, ...(roomId === undefined ? [] : [roomId])) as {
    batch_id: string;
    leader_name: string;
    room_id: number;
    created_at: string;
    status: MessageBatchStatus;
    completed_at: string | null;
  } | null;

  if (!row) return null;
  if (
    requireRunning &&
    (row.status !== 'running' || row.completed_at !== null)
  ) {
    return null;
  }

  return rowToOpenBatch(row);
}

function getLatestOpenBatchForWorker(
  workerName: string,
  roomId?: number,
): OpenBatchForWorker | null {
  const roomFilter = roomId === undefined ? '' : ' AND b.room_id = ?';
  const row = getDb()
    .query(
      `SELECT b.batch_id, b.leader_name, b.room_id, b.created_at
       FROM message_batches b
       JOIN message_batch_workers w ON w.batch_id = b.batch_id
       WHERE b.status = 'running'
         AND b.completed_at IS NULL
         AND w.worker_name = ?${roomFilter}
       ORDER BY b.created_at DESC, b.id DESC
       LIMIT 1`,
    )
    .get(workerName, ...(roomId === undefined ? [] : [roomId])) as {
    batch_id: string;
    leader_name: string;
    room_id: number;
    created_at: string;
  } | null;

  return row ? rowToOpenBatch(row) : null;
}

export function getLatestBatchForWorker(
  workerName: string,
  roomId?: number,
): LatestBatchForWorker | null {
  const roomFilter = roomId === undefined ? '' : ' AND b.room_id = ?';
  const row = getDb()
    .query(
      `SELECT b.batch_id, b.leader_name, b.room_id, b.created_at, b.status,
              w.terminal_status, w.final_message, w.finished_at
       FROM message_batches b
       JOIN message_batch_workers w ON w.batch_id = b.batch_id
       WHERE w.worker_name = ?${roomFilter}
       ORDER BY b.created_at DESC, b.id DESC
       LIMIT 1`,
    )
    .get(workerName, ...(roomId === undefined ? [] : [roomId])) as {
    batch_id: string;
    leader_name: string;
    room_id: number;
    created_at: string;
    status: MessageBatchStatus;
    terminal_status: MessageBatchWorkerTerminalStatus;
    final_message: string | null;
    finished_at: string | null;
  } | null;

  return row
    ? {
        batchId: row.batch_id,
        leaderName: row.leader_name,
        roomId: row.room_id,
        createdAt: row.created_at,
        status: row.status,
        terminal_status: row.terminal_status,
        final_message: row.final_message ?? null,
        finished_at: row.finished_at ?? null,
      }
    : null;
}

export function getOpenBatchForWorker(
  workerName: string,
  roomId?: number,
): OpenBatchForWorker | null {
  return getLatestOpenBatchForWorker(workerName, roomId);
}

export function getLatestBatchAssociationForWorker(
  workerName: string,
  roomId?: number,
): OpenBatchForWorker | null {
  return getLatestPersistedBatchAssociationForWorker(workerName, roomId, true);
}

export function getRenderableBatchWorkers(
  batchId: string,
): Array<{ worker_name: string; final_message: string | null }> {
  return (
    getDb()
      .query(
        'SELECT worker_name, final_message FROM message_batch_workers WHERE batch_id = ? ORDER BY manifest_order, id',
      )
      .all(batchId) as Array<{
      worker_name: string;
      final_message: string | null;
    }>
  ).map((row) => ({
    worker_name: row.worker_name,
    final_message: row.final_message ?? null,
  }));
}

function getBatchForTerminalUpdate(input: {
  batchId?: string;
  workerName: string;
  roomId?: number;
}): OpenBatchForWorker | null {
  if (input.batchId) {
    const row = getDb()
      .query(
        `SELECT b.batch_id AS batch_id,
                b.leader_name AS leader_name,
                b.room_id AS room_id,
                b.created_at AS created_at
         FROM message_batches b
         WHERE b.batch_id = ?
           AND b.status = 'running'
           AND b.completed_at IS NULL`,
      )
      .get(input.batchId) as {
      batch_id: string;
      leader_name: string;
      room_id: number;
      created_at: string;
    } | null;
    if (!row) return null;
    if (input.roomId !== undefined && row.room_id !== input.roomId) return null;
    return rowToOpenBatch(row);
  }

  return (
    getLatestPersistedBatchAssociationForWorker(
      input.workerName,
      input.roomId,
    ) ?? getLatestOpenBatchForWorker(input.workerName, input.roomId)
  );
}

export function recordBatchWorkerTerminalMessage(input: {
  batchId?: string;
  workerName: string;
  roomId?: number;
  terminalStatus: MessageBatchWorkerTerminalOutcome;
  finalMessage: string;
  errorText?: string | null;
}): RecordedBatchWorkerTerminalMessage | null {
  const resolvedBatch = getBatchForTerminalUpdate({
    batchId: input.batchId,
    workerName: input.workerName,
    roomId: input.roomId,
  });
  if (!resolvedBatch) return null;

  const db = getDb();
  const ts = now();

  return db.transaction(() => {
    const workerRow = db
      .query(
        `SELECT terminal_status
         FROM message_batch_workers
         WHERE batch_id = ? AND worker_name = ?`,
      )
      .get(resolvedBatch.batchId, input.workerName) as {
      terminal_status: MessageBatchWorkerTerminalStatus;
    } | null;
    if (!workerRow || workerRow.terminal_status !== 'running') return null;

    db.run(
      `UPDATE message_batch_workers
       SET dispatch_status = CASE WHEN dispatch_status = 'pending' THEN 'sent' ELSE dispatch_status END,
           terminal_status = ?,
           final_message = ?,
           error_text = ?,
           finished_at = ?,
           started_at = COALESCE(started_at, ?)
       WHERE batch_id = ? AND worker_name = ?`,
      [
        input.terminalStatus,
        input.finalMessage,
        input.errorText ?? null,
        ts,
        ts,
        resolvedBatch.batchId,
        input.workerName,
      ],
    );

    const shouldFinalize = shouldFinalizeBatch(db, resolvedBatch.batchId);

    return {
      batchId: resolvedBatch.batchId,
      leaderName: resolvedBatch.leaderName,
      roomId: resolvedBatch.roomId,
      createdAt: resolvedBatch.createdAt,
      shouldFinalize,
    };
  })();
}
