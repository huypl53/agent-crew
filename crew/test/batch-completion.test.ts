import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { deliverMessage } from '../src/delivery/index.ts';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  completeGoal,
  createMessageBatch,
  getBatchWorkers,
  getGoalByAgent,
  getRoom,
  getRoomMessages,
  setGoal,
} from '../src/state/index.ts';
import { handleJoinRoom } from '../src/tools/join-room.ts';
import { processHookEventInput } from '../src/tools/hook-event.ts';
import {
  captureFromPane,
  cleanupAllTestSessions,
  createTestSession,
  waitForPaneOutput,
} from './helpers.ts';

function makeBatchId(prefix: string): string {
  return `batch_${prefix}_${Date.now().toString(36)}`;
}

describe('batch completion rendering', () => {
  let leaderPane: string;
  let workerAPane: string;
  let workerBPane: string;

  beforeEach(async () => {
    initDb(':memory:');
    const leader = await createTestSession('batch-leader');
    const workerA = await createTestSession('batch-worker-a');
    const workerB = await createTestSession('batch-worker-b');
    leaderPane = leader.pane;
    workerAPane = workerA.pane;
    workerBPane = workerB.pane;

    await handleJoinRoom({
      room: 'crew',
      role: 'leader',
      name: 'lead-1',
      tmux_target: leaderPane,
    });
    await handleJoinRoom({
      room: 'crew',
      role: 'worker',
      name: 'worker-a',
      tmux_target: workerAPane,
    });
    await handleJoinRoom({
      room: 'crew',
      role: 'worker',
      name: 'worker-b',
      tmux_target: workerBPane,
    });
  });

  afterEach(async () => {
    await cleanupAllTestSessions();
    closeDb();
  });

  test.serial('explicit batch terminal sends one final render in manifest order', async () => {
    const room = getRoom('crew');
    expect(room).toBeDefined();

    const batchId = makeBatchId('explicit');
    createMessageBatch({
      batchId,
      roomId: room!.id,
      leaderName: 'lead-1',
      hintAfterSeconds: null,
      workers: [
        { workerName: 'worker-a', promptFile: 'prompts/a.md' },
        { workerName: 'worker-b', promptFile: 'prompts/b.md' },
      ],
    });

    await deliverMessage(
      'worker-b',
      'crew',
      'bravo result',
      'lead-1',
      'pull',
      'completion',
      undefined,
      { batch_id: batchId },
    );

    await Bun.sleep(200);
    const interimMessages = getRoomMessages('crew').filter(
      (message) => message.to === 'lead-1' && message.kind === 'completion',
    );
    expect(interimMessages).toHaveLength(0);

    await deliverMessage(
      'worker-a',
      'crew',
      'alpha result',
      'lead-1',
      'pull',
      'completion',
      undefined,
      { batch_id: batchId },
    );

    await Bun.sleep(1000);
    const finalMessages = getRoomMessages('crew').filter(
      (message) => message.to === 'lead-1' && message.kind === 'completion',
    );
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]?.text).toContain('## worker-a');
    expect(finalMessages[0]?.text).toContain('## worker-b');
    expect(finalMessages[0]?.text.indexOf('## worker-a') ?? -1).toBeLessThan(
      finalMessages[0]?.text.indexOf('## worker-b') ?? -1,
    );
  });

  test.serial('explicit batch terminal error events still finalize the batch', async () => {
    const room = getRoom('crew');
    expect(room).toBeDefined();

    const batchId = makeBatchId('explicit-error');
    createMessageBatch({
      batchId,
      roomId: room!.id,
      leaderName: 'lead-1',
      hintAfterSeconds: null,
      workers: [
        { workerName: 'worker-a', promptFile: 'prompts/a.md' },
        { workerName: 'worker-b', promptFile: 'prompts/b.md' },
      ],
    });

    await deliverMessage(
      'worker-b',
      'crew',
      'worker-b failed loudly',
      'lead-1',
      'pull',
      'error',
      undefined,
      { batch_id: batchId },
    );

    await Bun.sleep(200);
    expect(
      getBatchWorkers(batchId).find((worker) => worker.worker_name === 'worker-b')
        ?.terminal_status,
    ).toBe('error');

    await deliverMessage(
      'worker-a',
      'crew',
      'worker-a finished after the error',
      'lead-1',
      'pull',
      'completion',
      undefined,
      { batch_id: batchId },
    );

    await Bun.sleep(1000);
    const finalMessages = getRoomMessages('crew').filter(
      (message) => message.to === 'lead-1' && message.kind === 'completion',
    );
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]?.text).toContain('## worker-a');
    expect(finalMessages[0]?.text).toContain('## worker-b');
    expect(finalMessages[0]?.text).toContain('worker-b failed loudly');
  });

  test.serial('non-batch worker completions still notify leaders normally', async () => {
    const room = getRoom('crew');
    expect(room).toBeDefined();

    await deliverMessage(
      'worker-a',
      'crew',
      'plain completion',
      'lead-1',
      'pull',
      'completion',
    );

    await Bun.sleep(300);
    const leaderCapture = await captureFromPane(leaderPane);
    expect(leaderCapture).toContain('worker-a completion');
    expect(leaderCapture).toContain('plain completion');
  });

  test.serial('worker Stop path arms leader goal reminder after queue drain', async () => {
    const room = getRoom('crew');
    expect(room).toBeDefined();
    setGoal('lead-1', room!.id, 'Review worker stop output', { pane: leaderPane });

    await processHookEventInput(
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'worker-stop-1',
        last_assistant_message: 'worker stop completion',
      }),
      workerAPane,
    );

    await Bun.sleep(1000);
    expect(getGoalByAgent('lead-1', room!.id)?.leader_reminder_armed).toBe(1);

    await processHookEventInput(
      JSON.stringify({ hook_event_name: 'Stop', session_id: 'lead-stop-worker-path' }),
      leaderPane,
    );

    expect(getGoalByAgent('lead-1', room!.id)?.turn_count).toBe(1);
    expect(getGoalByAgent('lead-1', room!.id)?.leader_reminder_armed).toBe(0);
  });

  test.serial('active worker goal blocks Stop-driven batch final delivery until goal is done', async () => {
    const room = getRoom('crew');
    expect(room).toBeDefined();
    setGoal('worker-a', room!.id, 'Finish gated batch task', { pane: workerAPane });

    const batchId = makeBatchId('goal-gated-batch');
    createMessageBatch({
      batchId,
      roomId: room!.id,
      leaderName: 'lead-1',
      hintAfterSeconds: null,
      workers: [{ workerName: 'worker-a', promptFile: 'prompts/a.md' }],
    });

    await deliverMessage(
      'lead-1',
      'crew',
      'single task',
      'worker-a',
      'pull',
      'task',
      undefined,
      {
        batch_id: batchId,
        worker_name: 'worker-a',
        prompt_file: 'prompts/a.md',
        manifest_order: 0,
      },
    );

    await processHookEventInput(
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'worker-goal-gated-batch-1',
        last_assistant_message: 'single final',
      }),
      workerAPane,
    );

    await Bun.sleep(400);
    expect(getBatchWorkers(batchId)[0]?.terminal_status).toBe('running');
    expect(
      getRoomMessages('crew').filter(
        (message) => message.to === 'lead-1' && message.kind === 'completion',
      ),
    ).toHaveLength(0);

    expect(completeGoal('worker-a', room!.id)).toBe(true);

    await processHookEventInput(
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'worker-goal-gated-batch-2',
        last_assistant_message: 'single final',
      }),
      workerAPane,
    );

    await Bun.sleep(1200);
    expect(getBatchWorkers(batchId)[0]?.terminal_status).toBe('success');
    const finalMessages = getRoomMessages('crew').filter(
      (message) => message.to === 'lead-1' && message.kind === 'completion',
    );
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]?.text).toContain('## worker-a');
    expect(finalMessages[0]?.text).toContain('single final');
  });

  test.serial('leader goal reminder arms after non-batch queue drain and fires on next Stop', async () => {
    const room = getRoom('crew');
    expect(room).toBeDefined();
    setGoal('lead-1', room!.id, 'Review inbound results', { pane: leaderPane });

    await deliverMessage(
      'worker-a',
      'crew',
      'plain completion',
      'lead-1',
      'pull',
      'completion',
    );

    await Bun.sleep(300);
    expect(getGoalByAgent('lead-1', room!.id)?.turn_count).toBe(0);
    expect(getGoalByAgent('lead-1', room!.id)?.leader_reminder_armed).toBe(1);

    await processHookEventInput(
      JSON.stringify({ hook_event_name: 'Stop', session_id: 'lead-stop-1' }),
      leaderPane,
    );

    expect(getGoalByAgent('lead-1', room!.id)?.turn_count).toBe(1);
    expect(getGoalByAgent('lead-1', room!.id)?.leader_reminder_armed).toBe(0);

    await processHookEventInput(
      JSON.stringify({ hook_event_name: 'Stop', session_id: 'lead-stop-1' }),
      leaderPane,
    );
    expect(getGoalByAgent('lead-1', room!.id)?.turn_count).toBe(1);
  });

  test.serial('leader goal reminder arms after batch final queue drain and fires on next Stop', async () => {
    const room = getRoom('crew');
    expect(room).toBeDefined();
    setGoal('lead-1', room!.id, 'Review batch results', { pane: leaderPane });

    const batchId = makeBatchId('goal-arm-batch');
    createMessageBatch({
      batchId,
      roomId: room!.id,
      leaderName: 'lead-1',
      hintAfterSeconds: null,
      workers: [{ workerName: 'worker-a', promptFile: 'prompts/a.md' }],
    });

    await deliverMessage(
      'lead-1',
      'crew',
      'single task',
      'worker-a',
      'pull',
      'task',
      undefined,
      {
        batch_id: batchId,
        worker_name: 'worker-a',
        prompt_file: 'prompts/a.md',
        manifest_order: 0,
      },
    );
    await deliverMessage(
      'worker-a',
      'crew',
      'single final',
      'lead-1',
      'pull',
      'completion',
      undefined,
      { batch_id: batchId },
    );

    await Bun.sleep(2000);
    expect(getGoalByAgent('lead-1', room!.id)?.turn_count).toBe(0);
    expect(getGoalByAgent('lead-1', room!.id)?.leader_reminder_armed).toBe(1);

    await processHookEventInput(
      JSON.stringify({ hook_event_name: 'Stop', session_id: 'lead-stop-batch' }),
      leaderPane,
    );

    expect(getGoalByAgent('lead-1', room!.id)?.turn_count).toBe(1);
    expect(getGoalByAgent('lead-1', room!.id)?.leader_reminder_armed).toBe(0);
  });

  test.serial(
    'explicit batch-tagged completion falls back safely when batch recording fails',
    async () => {
      const room = getRoom('crew');
      expect(room).toBeDefined();

      await deliverMessage(
        'worker-a',
        'crew',
        'orphaned completion',
        'lead-1',
        'pull',
        'completion',
        undefined,
        { batch_id: 'missing-batch' },
      );

      await Bun.sleep(300);
      const fallbackMessages = getRoomMessages('crew').filter(
        (message) => message.to === 'lead-1' && message.kind === 'completion',
      );
      expect(fallbackMessages).toHaveLength(1);
      expect(fallbackMessages[0]?.text).toContain('orphaned completion');
    },
  );

  test.serial('duplicate stop after batch finalization does not fall through to legacy notification', async () => {
    const room = getRoom('crew');
    expect(room).toBeDefined();

    const batchId = makeBatchId('stop-idempotent');
    createMessageBatch({
      batchId,
      roomId: room!.id,
      leaderName: 'lead-1',
      hintAfterSeconds: null,
      workers: [{ workerName: 'worker-a', promptFile: 'prompts/a.md' }],
    });

    await deliverMessage(
      'lead-1',
      'crew',
      'single task',
      'worker-a',
      'pull',
      'task',
      undefined,
      {
        batch_id: batchId,
        worker_name: 'worker-a',
        prompt_file: 'prompts/a.md',
        manifest_order: 0,
      },
    );

    await deliverMessage(
      'worker-a',
      'crew',
      'single final',
      'lead-1',
      'pull',
      'completion',
      undefined,
      { batch_id: batchId },
    );

    await Bun.sleep(1000);
    const beforeStop = getRoomMessages('crew').filter(
      (message) => message.kind === 'completion',
    );
    expect(beforeStop).toHaveLength(1);

    await processHookEventInput(
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'stop-worker-a',
        last_assistant_message: 'single final',
      }),
      workerAPane,
    );

    await Bun.sleep(200);
    const afterStop = getRoomMessages('crew').filter(
      (message) => message.kind === 'completion',
    );
    expect(afterStop).toHaveLength(1);
  });

  test.serial('non-batch stop after a newer turn is not suppressed by matching batch text', async () => {
    const room = getRoom('crew');
    expect(room).toBeDefined();

    const batchId = makeBatchId('same-text-later-turn');
    createMessageBatch({
      batchId,
      roomId: room!.id,
      leaderName: 'lead-1',
      hintAfterSeconds: null,
      workers: [{ workerName: 'worker-a', promptFile: 'prompts/a.md' }],
    });

    await deliverMessage(
      'lead-1',
      'crew',
      'batch task',
      'worker-a',
      'pull',
      'task',
      undefined,
      {
        batch_id: batchId,
        worker_name: 'worker-a',
        prompt_file: 'prompts/a.md',
        manifest_order: 0,
      },
    );

    await deliverMessage(
      'worker-a',
      'crew',
      'done',
      'lead-1',
      'pull',
      'completion',
      undefined,
      { batch_id: batchId },
    );

    await Bun.sleep(1000);
    expect(
      getRoomMessages('crew').filter(
        (message) => message.to === 'lead-1' && message.kind === 'completion',
      ),
    ).toHaveLength(1);

    await processHookEventInput(
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'later-turn-submit',
      }),
      workerAPane,
    );

    const leaderDelivery = await waitForPaneOutput(
      leaderPane,
      /\[worker-a@crew\] completed:/,
      7000,
      async () => {
        await processHookEventInput(
          JSON.stringify({
            hook_event_name: 'Stop',
            session_id: 'later-turn-stop',
            last_assistant_message: 'done',
          }),
          workerAPane,
        );
      },
    );

    expect(leaderDelivery.matched).toBe(true);
    expect(leaderDelivery.seen).toContain('[worker-a@crew] completed:');
    expect(leaderDelivery.seen).toContain('done');

    const completionMessages = getRoomMessages('crew').filter(
      (message) => message.kind === 'completion',
    );
    expect(completionMessages).toHaveLength(2);
  });

  test.serial(
    'stop hook prefers persisted batch metadata over a newer same-name open batch',
    async () => {
      const room = getRoom('crew');
      expect(room).toBeDefined();

      const batchOne = makeBatchId('same-name-one');
      const batchTwo = makeBatchId('same-name-two');
      createMessageBatch({
        batchId: batchOne,
        roomId: room!.id,
        leaderName: 'lead-1',
        hintAfterSeconds: null,
        workers: [{ workerName: 'worker-a', promptFile: 'prompts/a.md' }],
      });
      createMessageBatch({
        batchId: batchTwo,
        roomId: room!.id,
        leaderName: 'lead-1',
        hintAfterSeconds: null,
        workers: [{ workerName: 'worker-a', promptFile: 'prompts/a.md' }],
      });

      await deliverMessage(
        'lead-1',
        'crew',
        'batch-one task',
        'worker-a',
        'pull',
        'task',
        undefined,
        {
          batch_id: batchOne,
          worker_name: 'worker-a',
          prompt_file: 'prompts/a.md',
          manifest_order: 0,
        },
      );

      await processHookEventInput(
        JSON.stringify({
          hook_event_name: 'Stop',
          session_id: 'same-name-stop',
          last_assistant_message: 'batch one done',
        }),
        workerAPane,
      );

      expect(getBatchWorkers(batchOne)[0]?.terminal_status).toBe('success');
      expect(getBatchWorkers(batchTwo)[0]?.terminal_status).toBe('running');
    },
  );

  test.serial('stop-hook batch completions suppress per-worker leader notifications', async () => {
    const room = getRoom('crew');
    expect(room).toBeDefined();

    const batchId = makeBatchId('stop');
    createMessageBatch({
      batchId,
      roomId: room!.id,
      leaderName: 'lead-1',
      hintAfterSeconds: null,
      workers: [
        { workerName: 'worker-a', promptFile: 'prompts/a.md' },
        { workerName: 'worker-b', promptFile: 'prompts/b.md' },
      ],
    });

    await processHookEventInput(
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'stop-worker-b',
        last_assistant_message: 'worker-b finished',
      }),
      workerBPane,
    );

    await Bun.sleep(200);
    const interim = await captureFromPane(leaderPane);
    expect(interim).not.toContain('worker-b finished');

    await processHookEventInput(
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'stop-worker-a',
        last_assistant_message: 'worker-a finished',
      }),
      workerAPane,
    );

    await Bun.sleep(1000);
    const finalMessages = getRoomMessages('crew').filter(
      (message) => message.to === 'lead-1' && message.kind === 'completion',
    );
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]?.text).toContain('## worker-a');
    expect(finalMessages[0]?.text).toContain('## worker-b');
    expect(finalMessages[0]?.text.indexOf('## worker-a') ?? -1).toBeLessThan(
      finalMessages[0]?.text.indexOf('## worker-b') ?? -1,
    );
  });

  test.serial('empty batch messages still render headings', async () => {
    const room = getRoom('crew');
    expect(room).toBeDefined();

    const batchId = makeBatchId('empty');
    createMessageBatch({
      batchId,
      roomId: room!.id,
      leaderName: 'lead-1',
      hintAfterSeconds: null,
      workers: [{ workerName: 'worker-a', promptFile: 'prompts/a.md' }],
    });

    await deliverMessage(
      'worker-a',
      'crew',
      '',
      'lead-1',
      'pull',
      'completion',
      undefined,
      { batch_id: batchId },
    );

    await Bun.sleep(200);
    const output = getRoomMessages('crew').filter(
      (message) => message.to === 'lead-1' && message.kind === 'completion',
    );
    expect(output).toHaveLength(1);
    expect(output[0]?.text).toContain('## worker-a');
  });

  test.serial('duplicate terminal events do not duplicate the final batch message', async () => {
    const room = getRoom('crew');
    expect(room).toBeDefined();

    const batchId = makeBatchId('dedupe');
    createMessageBatch({
      batchId,
      roomId: room!.id,
      leaderName: 'lead-1',
      hintAfterSeconds: null,
      workers: [{ workerName: 'worker-a', promptFile: 'prompts/a.md' }],
    });

    await deliverMessage(
      'worker-a',
      'crew',
      'single final',
      'lead-1',
      'pull',
      'completion',
      undefined,
      { batch_id: batchId },
    );

    await Bun.sleep(200);
    const firstRender = getRoomMessages('crew').filter(
      (message) => message.to === 'lead-1' && message.kind === 'completion',
    );
    expect(firstRender).toHaveLength(1);
    expect(firstRender[0]?.text.match(/## worker-a/g)?.length ?? 0).toBe(1);

    await deliverMessage(
      'worker-a',
      'crew',
      'single final',
      'lead-1',
      'pull',
      'completion',
      undefined,
      { batch_id: batchId },
    );

    await Bun.sleep(200);
    const afterDuplicate = getRoomMessages('crew').filter(
      (message) => message.to === 'lead-1' && message.kind === 'completion',
    );
    expect(afterDuplicate).toHaveLength(1);
    expect(afterDuplicate[0]?.text.match(/## worker-a/g)?.length ?? 0).toBe(1);
  });
});
