import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { captureFromPane, cleanupAllTestSessions, createTestSession } from './helpers.ts';
import { handleJoinRoom } from '../src/tools/join-room.ts';
import {
  createMessageBatch,
  getMessageBatch,
  getRoom,
  listHintableBatches,
  setSweepPaused,
} from '../src/state/index.ts';
import { closeDb, initDb } from '../src/state/db.ts';
import { getSweepRuntimeStats, resetSweepRuntimeState, runSweepOnce } from '../src/server/sweep.ts';

function makeBatchId(prefix: string): string {
  return `batch_${prefix}_${Date.now().toString(36)}`;
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('batch hint sweep delivery', () => {
  let leaderPane: string;

  beforeEach(async () => {
    initDb(':memory:');

    const leader = await createTestSession('batch-hint-leader');
    const workerA = await createTestSession('batch-hint-worker-a');
    const workerB = await createTestSession('batch-hint-worker-b');

    leaderPane = leader.pane;

    await handleJoinRoom({
      room: 'crew',
      role: 'leader',
      name: 'lead-1',
      tmux_target: leader.pane,
    });
    await handleJoinRoom({
      room: 'crew',
      role: 'worker',
      name: 'worker-a',
      tmux_target: workerA.pane,
    });
    await handleJoinRoom({
      room: 'crew',
      role: 'worker',
      name: 'worker-b',
      tmux_target: workerB.pane,
    });
  });

  afterEach(async () => {
    resetSweepRuntimeState();
    setSweepPaused(false);
    await cleanupAllTestSessions();
    closeDb();
  });

  test.serial('stale batch hints reuse deferred leader delivery when paused', async () => {
    const room = getRoom('crew');
    expect(room).toBeDefined();

    const batchId = makeBatchId('deferred');
    createMessageBatch({
      batchId,
      roomId: room!.id,
      leaderName: 'lead-1',
      hintAfterSeconds: 1,
      workers: [
        { workerName: 'worker-a', promptFile: 'prompts/a.md' },
        { workerName: 'worker-b', promptFile: 'prompts/b.md' },
      ],
    });

    setSweepPaused(true, 'test pause');
    await Bun.sleep(1200);

    await runSweepOnce();
    await Bun.sleep(250);

    const pausedPane = await captureFromPane(leaderPane);
    expect(pausedPane).not.toContain('Batch pending:');
    expect(getSweepRuntimeStats().deferred_total).toBeGreaterThan(0);

    const batch = getMessageBatch(batchId);
    expect(batch?.status).toBe('running');
    expect(batch?.completed_at).toBeNull();
    expect(batch?.hint_sent_at).not.toBeNull();

    setSweepPaused(false);
    await runSweepOnce();
    await Bun.sleep(250);

    const deliveredPane = await captureFromPane(leaderPane);
    expect(deliveredPane).toContain('Batch pending: worker-a, worker-b');
    expect(deliveredPane).toContain('Inspect them directly.');
  });

  test.serial('batch hints are sent only once per batch', async () => {
    const room = getRoom('crew');
    expect(room).toBeDefined();

    const batchId = makeBatchId('one-time');
    createMessageBatch({
      batchId,
      roomId: room!.id,
      leaderName: 'lead-1',
      hintAfterSeconds: 1,
      workers: [
        { workerName: 'worker-a', promptFile: 'prompts/a.md' },
        { workerName: 'worker-b', promptFile: 'prompts/b.md' },
      ],
    });

    await Bun.sleep(1200);

    setSweepPaused(true, 'test pause');
    await runSweepOnce();

    const firstHintAt = getMessageBatch(batchId)?.hint_sent_at;
    expect(firstHintAt).not.toBeNull();
    expect(listHintableBatches(new Date().toISOString())).toHaveLength(0);
    expect(getSweepRuntimeStats().deferred_total).toBeGreaterThan(0);
  });
});
