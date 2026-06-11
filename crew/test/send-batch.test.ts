import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { closeDb, getDb, initDb } from '../src/state/db.ts';
import {
  addAgent,
  areAllBatchWorkersTerminal,
  completeBatchWorker,
  createMessageBatch,
  getBatchWorkers,
  getMessageBatch,
  getOrCreateRoom,
  listIncompleteBatches,
  markBatchCompleted,
  markBatchHintSent,
  markBatchWorkerDispatchFailed,
  markBatchWorkerSent,
} from '../src/state/index.ts';
import { handleJoinRoom } from '../src/tools/join-room.ts';
import { handleSendBatch } from '../src/tools/send-batch.ts';
import {
  cleanupAllTestSessions,
  createTestSession,
  getCallerTestTag,
} from './helpers.ts';

function mkRoom(name: string): number {
  return getOrCreateRoom(`/test/${name}`, name).id;
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = `/tmp/${prefix}-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  await Bun.write(filePath, content);
}

describe('batch state primitives', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(async () => {
    await cleanupAllTestSessions(getCallerTestTag());
    closeDb();
  });

  test.serial('creates one batch row and ordered worker rows', () => {
    const roomId = mkRoom('batch-room');

    const batch = createMessageBatch({
      batchId: 'batch-001',
      roomId,
      leaderName: 'lead',
      hintAfterSeconds: 900,
      workers: [
        { workerName: 'worker-a', promptFile: 'prompts/a.md' },
        { workerName: 'worker-b', promptFile: 'prompts/b.md' },
        { workerName: 'worker-c', promptFile: 'prompts/c.md' },
      ],
    });

    expect(batch.batch_id).toBe('batch-001');
    expect(batch.room_id).toBe(roomId);
    expect(batch.leader_name).toBe('lead');
    expect(batch.status).toBe('running');
    expect(batch.hint_after_seconds).toBe(900);
    expect(batch.hint_sent_at).toBeNull();
    expect(batch.completed_at).toBeNull();

    const db = getDb();
    const batchRows = db
      .query('SELECT COUNT(*) AS count FROM message_batches WHERE batch_id = ?')
      .get('batch-001') as { count: number };
    const workerRows = db
      .query('SELECT COUNT(*) AS count FROM message_batch_workers WHERE batch_id = ?')
      .get('batch-001') as { count: number };

    expect(batchRows.count).toBe(1);
    expect(workerRows.count).toBe(3);
    expect(getBatchWorkers('batch-001').map((worker) => worker.worker_name)).toEqual([
      'worker-a',
      'worker-b',
      'worker-c',
    ]);
    expect(getMessageBatch('batch-001')).toEqual(batch);
  });

  test.serial('keeps manifest order when worker rows are read back', () => {
    const roomId = mkRoom('manifest-room');

    createMessageBatch({
      batchId: 'batch-ordered',
      roomId,
      leaderName: 'lead',
      hintAfterSeconds: null,
      workers: [
        { workerName: 'worker-z', promptFile: 'prompts/z.md' },
        { workerName: 'worker-a', promptFile: 'prompts/a.md' },
        { workerName: 'worker-m', promptFile: 'prompts/m.md' },
      ],
    });

    expect(getBatchWorkers('batch-ordered').map((worker) => worker.manifest_order)).toEqual([
      0,
      1,
      2,
    ]);
    expect(getBatchWorkers('batch-ordered').map((worker) => worker.worker_name)).toEqual([
      'worker-z',
      'worker-a',
      'worker-m',
    ]);
  });

  test.serial('defaults hint state and exposes query/update helpers', () => {
    const roomId = mkRoom('state-room');

    createMessageBatch({
      batchId: 'batch-state',
      roomId,
      leaderName: 'lead',
      hintAfterSeconds: null,
      workers: [{ workerName: 'worker-a', promptFile: 'prompts/a.md' }],
    });

    expect(getMessageBatch('batch-state')?.hint_sent_at).toBeNull();
    expect(listIncompleteBatches('2026-06-11T10:48:00.000Z').map((batch) => batch.batch_id)).toEqual([
      'batch-state',
    ]);
    expect(areAllBatchWorkersTerminal('batch-state')).toBe(false);

    markBatchWorkerSent('batch-state', 'worker-a');
    completeBatchWorker('batch-state', 'worker-a', 'success', 'done');
    markBatchHintSent('batch-state', '2026-06-11T10:48:00.000Z');
    markBatchCompleted('batch-state', '2026-06-11T10:49:00.000Z');

    const batch = getMessageBatch('batch-state');
    const worker = getBatchWorkers('batch-state')[0];

    expect(batch?.hint_sent_at).toBe('2026-06-11T10:48:00.000Z');
    expect(batch?.status).toBe('completed');
    expect(batch?.completed_at).toBe('2026-06-11T10:49:00.000Z');
    expect(worker.dispatch_status).toBe('sent');
    expect(worker.terminal_status).toBe('success');
    expect(worker.final_message).toBe('done');
    expect(worker.error_text).toBeNull();
    expect(worker.started_at).not.toBeNull();
    expect(worker.finished_at).not.toBeNull();
    expect(areAllBatchWorkersTerminal('batch-state')).toBe(true);
  });

  test.serial('ignores late duplicate worker callbacks after terminal completion', () => {
    const roomId = mkRoom('late-callback-room');

    createMessageBatch({
      batchId: 'batch-late',
      roomId,
      leaderName: 'lead',
      hintAfterSeconds: null,
      workers: [{ workerName: 'worker-a', promptFile: 'prompts/a.md' }],
    });

    markBatchWorkerSent('batch-late', 'worker-a');
    completeBatchWorker('batch-late', 'worker-a', 'success', 'done');

    const before = getBatchWorkers('batch-late')[0];

    markBatchWorkerSent('batch-late', 'worker-a');
    markBatchWorkerDispatchFailed('batch-late', 'worker-a', 'retry later');
    completeBatchWorker('batch-late', 'worker-a', 'error', 'late overwrite');

    expect(getBatchWorkers('batch-late')[0]).toEqual(before);
    expect(areAllBatchWorkersTerminal('batch-late')).toBe(true);
  });

  test.serial('rejects non-terminal completion status', () => {
    const roomId = mkRoom('invalid-status-room');

    createMessageBatch({
      batchId: 'batch-invalid-status',
      roomId,
      leaderName: 'lead',
      hintAfterSeconds: null,
      workers: [{ workerName: 'worker-a', promptFile: 'prompts/a.md' }],
    });

    expect(() =>
      completeBatchWorker(
        'batch-invalid-status',
        'worker-a',
        'running' as never,
        'should fail',
      ),
    ).toThrow('Invalid terminal status: running');
  });

describe('send-batch command', () => {
  test.serial('rejects malformed manifest JSON before any dispatch', async () => {
    const room = 'send-batch-invalid-json';
    const tempDir = await makeTempDir(room);
    const manifestPath = `${tempDir}/manifest.json`;
    await writeTextFile(manifestPath, '{ not valid json');

    const leaderSession = await createTestSession(`${room}-leader`);
    try {
      const joinResult = await handleJoinRoom({
        room,
        role: 'leader',
        name: 'lead-1',
        tmux_target: leaderSession.pane,
      });
      expect(joinResult.isError).toBeUndefined();

      const result = await handleSendBatch({
        room,
        manifest: manifestPath,
        name: 'lead-1',
      });

      expect(result.isError).toBe(true);
      const batchRows = getDb()
        .query('SELECT COUNT(*) AS count FROM message_batches')
        .get() as { count: number };
      const messageRows = getDb()
        .query('SELECT COUNT(*) AS count FROM messages')
        .get() as { count: number };
      expect(batchRows.count).toBe(0);
      expect(messageRows.count).toBe(0);
    } finally {
      await cleanupAllTestSessions(getCallerTestTag());
    }
  });

  test.serial('rejects a missing worker prompt file before dispatch', async () => {
    const room = 'send-batch-missing-file';
    const tempDir = await makeTempDir(room);
    const manifestPath = `${tempDir}/manifest.json`;
    const existingPrompt = `${tempDir}/worker-a.md`;
    await writeTextFile(existingPrompt, 'Task for worker A');
    await writeTextFile(
      manifestPath,
      JSON.stringify(
        {
          leader: 'lead-1',
          workers: [
            { name: 'worker-a', file: existingPrompt },
            { name: 'worker-b', file: `${tempDir}/missing.md` },
          ],
        },
        null,
        2,
      ),
    );

    const leaderSession = await createTestSession(`${room}-leader`);
    const workerSession = await createTestSession(`${room}-worker-a`);
    try {
      await handleJoinRoom({
        room,
        role: 'leader',
        name: 'lead-1',
        tmux_target: leaderSession.pane,
      });
      await handleJoinRoom({
        room,
        role: 'worker',
        name: 'worker-a',
        tmux_target: workerSession.pane,
      });

      const result = await handleSendBatch({
        room,
        manifest: manifestPath,
        name: 'lead-1',
      });

      expect(result.isError).toBe(true);
      const batchRows = getDb()
        .query('SELECT COUNT(*) AS count FROM message_batches')
        .get() as { count: number };
      const messageRows = getDb()
        .query('SELECT COUNT(*) AS count FROM messages')
        .get() as { count: number };
      expect(batchRows.count).toBe(0);
      expect(messageRows.count).toBe(0);
    } finally {
      await cleanupAllTestSessions(getCallerTestTag());
    }
  });

  test.serial('rejects duplicate worker names before dispatch', async () => {
    const room = 'send-batch-duplicate-workers';
    const tempDir = await makeTempDir(room);
    const manifestPath = `${tempDir}/manifest.json`;
    await writeTextFile(
      manifestPath,
      JSON.stringify(
        {
          leader: 'lead-1',
          workers: [
            { name: 'worker-a', file: `${tempDir}/worker-a.md` },
            { name: 'worker-a', file: `${tempDir}/worker-b.md` },
          ],
        },
        null,
        2,
      ),
    );

    const leaderSession = await createTestSession(`${room}-leader`);
    try {
      await handleJoinRoom({
        room,
        role: 'leader',
        name: 'lead-1',
        tmux_target: leaderSession.pane,
      });

      const result = await handleSendBatch({
        room,
        manifest: manifestPath,
        name: 'lead-1',
      });

      expect(result.isError).toBe(true);
      const batchRows = getDb()
        .query('SELECT COUNT(*) AS count FROM message_batches')
        .get() as { count: number };
      const messageRows = getDb()
        .query('SELECT COUNT(*) AS count FROM messages')
        .get() as { count: number };
      expect(batchRows.count).toBe(0);
      expect(messageRows.count).toBe(0);
    } finally {
      await cleanupAllTestSessions(getCallerTestTag());
    }
  });

  test.serial('aborts before dispatch when a later worker is not ready', async () => {
    const room = 'send-batch-preflight-fail';
    const tempDir = await makeTempDir(room);
    const manifestPath = `${tempDir}/manifest.json`;
    const workerAPrompt = `${tempDir}/worker-a.md`;
    const workerBPrompt = `${tempDir}/worker-b.md`;
    await writeTextFile(workerAPrompt, 'Task for worker A');
    await writeTextFile(workerBPrompt, 'Task for worker B');
    await writeTextFile(
      manifestPath,
      JSON.stringify(
        {
          leader: 'lead-1',
          workers: [
            { name: 'worker-a', file: workerAPrompt },
            { name: 'worker-b', file: workerBPrompt },
          ],
        },
        null,
        2,
      ),
    );

    const leaderSession = await createTestSession(`${room}-leader`);
    const workerSession = await createTestSession(`${room}-worker-a`);
    try {
      await handleJoinRoom({
        room,
        role: 'leader',
        name: 'lead-1',
        tmux_target: leaderSession.pane,
      });
      await handleJoinRoom({
        room,
        role: 'worker',
        name: 'worker-a',
        tmux_target: workerSession.pane,
      });
      addAgent('worker-b', 'worker', mkRoom(room), null, 'unknown');

      const result = await handleSendBatch({
        room,
        manifest: manifestPath,
        name: 'lead-1',
      });

      expect(result.isError).toBe(true);
      const batchRows = getDb()
        .query('SELECT COUNT(*) AS count FROM message_batches')
        .get() as { count: number };
      const messageRows = getDb()
        .query('SELECT COUNT(*) AS count FROM messages')
        .get() as { count: number };
      expect(batchRows.count).toBe(0);
      expect(messageRows.count).toBe(0);
    } finally {
      await cleanupAllTestSessions(getCallerTestTag());
    }
  });

  test.serial('dispatches workers in manifest order and persists results', async () => {
    const room = 'send-batch-success';
    const tempDir = await makeTempDir(room);
    const manifestPath = `${tempDir}/manifest.json`;
    const workerAPrompt = `${tempDir}/worker-a.md`;
    const workerBPrompt = `${tempDir}/worker-b.md`;
    await writeTextFile(workerAPrompt, 'Task for worker A');
    await writeTextFile(workerBPrompt, 'Task for worker B');
    await writeTextFile(
      manifestPath,
      JSON.stringify(
        {
          leader: 'lead-1',
          workers: [
            { name: 'worker-b', file: workerBPrompt },
            { name: 'worker-a', file: workerAPrompt },
          ],
          hintAfterSeconds: 900,
        },
        null,
        2,
      ),
    );

    const leaderSession = await createTestSession(`${room}-leader`);
    const workerASession = await createTestSession(`${room}-worker-a`);
    const workerBSession = await createTestSession(`${room}-worker-b`);
    try {
      await handleJoinRoom({
        room,
        role: 'leader',
        name: 'lead-1',
        tmux_target: leaderSession.pane,
      });
      await handleJoinRoom({
        room,
        role: 'worker',
        name: 'worker-a',
        tmux_target: workerASession.pane,
      });
      await handleJoinRoom({
        room,
        role: 'worker',
        name: 'worker-b',
        tmux_target: workerBSession.pane,
      });

      const result = await handleSendBatch({
        room,
        manifest: manifestPath,
        name: 'lead-1',
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]?.text);
      expect(data.batch_id).toBeDefined();
      expect(data.workers).toEqual([
        { name: 'worker-b', dispatch_status: 'sent' },
        { name: 'worker-a', dispatch_status: 'sent' },
      ]);

      const batchRows = getDb()
        .query('SELECT COUNT(*) AS count FROM message_batches')
        .get() as { count: number };
      const messageRows = getDb()
        .query(
          'SELECT recipient, batch_id, worker_name, prompt_file, manifest_order FROM messages ORDER BY id',
        )
        .all() as Array<{
        recipient: string | null;
        batch_id: string | null;
        worker_name: string | null;
        prompt_file: string | null;
        manifest_order: number | null;
      }>;

      expect(batchRows.count).toBe(1);
      expect(getBatchWorkers(data.batch_id).map((worker) => worker.worker_name)).toEqual([
        'worker-b',
        'worker-a',
      ]);
      expect(getBatchWorkers(data.batch_id).map((worker) => worker.dispatch_status)).toEqual([
        'sent',
        'sent',
      ]);
      expect(getBatchWorkers(data.batch_id).map((worker) => worker.manifest_order)).toEqual([
        0,
        1,
      ]);
      expect(messageRows.map((row) => row.recipient)).toEqual(['worker-b', 'worker-a']);
      expect(messageRows.map((row) => row.batch_id)).toEqual([data.batch_id, data.batch_id]);
      expect(messageRows.map((row) => row.worker_name)).toEqual(['worker-b', 'worker-a']);
      expect(messageRows.map((row) => row.manifest_order)).toEqual([0, 1]);
      expect(messageRows.map((row) => row.prompt_file)).toEqual([
        workerBPrompt,
        workerAPrompt,
      ]);
    } finally {
      await cleanupAllTestSessions(getCallerTestTag());
    }
  });
});

});
