import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { deliverMessage } from '../src/delivery/index.ts';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  completeGoal,
  createMessageBatch,
  getGoalByAgent,
  getRoom,
  setAgentInputBlockMode,
  setGoal,
} from '../src/state/index.ts';
import { handleInputBlock } from '../src/tools/input-block.ts';
import { processHookEventInput } from '../src/tools/hook-event.ts';
import {
  assertPaneAfterMarkerLacks,
  capturePaneAfterMarker,
  cleanupAllTestSessions,
  createTestSession,
  expectTextInOrder,
  sendPaneMarker,
  waitForPaneAfterMarkerToContain,
  waitForPaneOutput,
  waitForPaneToContain,
} from './helpers.ts';

setDefaultTimeout(20000);

class ScenarioTrace {
  private entries: string[] = [];

  add(message: string): void {
    this.entries.push(`[${new Date().toISOString()}] ${message}`);
  }

  dump(): string {
    return this.entries.join('\n');
  }
}

function makeBatchId(prefix: string): string {
  return `batch_${prefix}_${Date.now().toString(36)}`;
}

async function waitForGoalState(
  agentName: string,
  roomId: number,
  predicate: (goal: ReturnType<typeof getGoalByAgent>) => boolean,
  failure: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<NonNullable<ReturnType<typeof getGoalByAgent>>> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const intervalMs = opts?.intervalMs ?? 50;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const goal = getGoalByAgent(agentName, roomId);
    if (predicate(goal)) return goal!;
    await Bun.sleep(intervalMs);
  }

  const goal = getGoalByAgent(agentName, roomId);
  throw new Error(`${failure}\nLast goal state: ${JSON.stringify(goal, null, 2)}`);
}

type PaneKey = 'leader' | 'worker-1' | 'worker-2';

class GoalReminderUATHarness {
  constructor(
    private readonly roomId: number,
    private readonly panes: Record<PaneKey, string>,
    private readonly trace: ScenarioTrace,
  ) {}

  pane(key: PaneKey): string {
    return this.panes[key];
  }

  async markPane(key: PaneKey, marker: string, waitForPrompt = false): Promise<void> {
    await sendPaneMarker(this.pane(key), marker);
    await waitForPaneToContain(this.pane(key), marker);
    if (waitForPrompt) {
      await waitForPaneAfterMarkerToContain(this.pane(key), marker, '$');
    }
    this.trace.add(`${key} marker written: ${marker}`);
  }

  setGoal(agentName: string, description: string, paneKey: PaneKey): void {
    setGoal(agentName, this.roomId, description, { pane: this.pane(paneKey) });
    this.trace.add(`${agentName} goal set: ${description}`);
  }

  async waitForGoal(
    agentName: string,
    predicate: (goal: ReturnType<typeof getGoalByAgent>) => boolean,
    failure: string,
  ) {
    return waitForGoalState(agentName, this.roomId, predicate, `${failure}\n${this.trace.dump()}`);
  }

  goal(agentName: string) {
    return getGoalByAgent(agentName, this.roomId);
  }

  async assertNoPaneText(key: PaneKey, marker: string, text: string, settleMs = 1200) {
    await assertPaneAfterMarkerLacks(this.pane(key), marker, text, { settleMs });
  }

  async waitForPaneText(key: PaneKey, marker: string, text: string, timeoutMs = 7000) {
    return waitForPaneAfterMarkerToContain(this.pane(key), marker, text, { timeoutMs });
  }

  async waitForReminderOnStop(
    key: PaneKey,
    pattern: RegExp,
    sessionId: string,
    traceMessage: string,
  ): Promise<void> {
    const result = await waitForPaneOutput(this.pane(key), pattern, 7000, async () => {
      await processHookEventInput(
        JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId }),
        this.pane(key),
      );
      this.trace.add(traceMessage);
    });
    expect(result.matched).toBe(true);
  }

  async paneAfterMarker(key: PaneKey, marker: string): Promise<string> {
    return capturePaneAfterMarker(this.pane(key), marker);
  }
}

describe('goal reminder UAT harness', () => {
  let leaderPane: string;
  let workerPane: string;
  let workerTwoPane: string;

  beforeEach(async () => {
    initDb(':memory:');
    leaderPane = (await createTestSession('uat-leader')).pane;
    workerPane = (await createTestSession('uat-worker')).pane;
    workerTwoPane = (await createTestSession('uat-worker-two')).pane;

    const { handleJoinRoom } = await import('../src/tools/join-room.ts');
    await handleJoinRoom({
      room: 'crew',
      role: 'leader',
      name: 'lead-1',
      tmux_target: leaderPane,
    });
    await handleJoinRoom({
      room: 'crew',
      role: 'worker',
      name: 'worker-1',
      tmux_target: workerPane,
    });
    await handleJoinRoom({
      room: 'crew',
      role: 'worker',
      name: 'worker-2',
      tmux_target: workerTwoPane,
    });
  });

  afterEach(async () => {
    await cleanupAllTestSessions();
    closeDb();
  });

  test.serial('uat: worker reminder still appears on every Stop hook', async () => {
    const trace = new ScenarioTrace();
    const room = getRoom('crew');
    expect(room).toBeDefined();
    const harness = new GoalReminderUATHarness(
      room!.id,
      { leader: leaderPane, 'worker-1': workerPane, 'worker-2': workerTwoPane },
      trace,
    );

    harness.setGoal('worker-1', 'Finish worker task', 'worker-1');

    const marker = '=== worker-stop-uat ===';
    await harness.markPane('worker-1', marker, true);

    const firstReminder = await waitForPaneOutput(
      harness.pane('worker-1'),
      /🎯 Goal: Finish worker task \(turn 1\)/,
      7000,
      async () => {
        await processHookEventInput(
          JSON.stringify({
            hook_event_name: 'Stop',
            session_id: 'worker-stop-1',
            last_assistant_message: 'worker output turn 1',
          }),
          harness.pane('worker-1'),
        );
        trace.add('worker Stop #1 fired');
      },
    );
    expect(firstReminder.matched).toBe(true);
    trace.add('worker reminder turn 1 observed');

    const secondReminder = await waitForPaneOutput(
      harness.pane('worker-1'),
      /🎯 Goal: Finish worker task \(turn 2\)/,
      7000,
      async () => {
        await processHookEventInput(
          JSON.stringify({
            hook_event_name: 'Stop',
            session_id: 'worker-stop-1',
            last_assistant_message: 'worker output turn 2',
          }),
          harness.pane('worker-1'),
        );
        trace.add('worker Stop #2 fired');
      },
    );
    expect(secondReminder.matched).toBe(true);

    const output = await harness.waitForPaneText('worker-1', marker, '🎯 Goal: Finish worker task (turn 2)');
    trace.add('worker reminder turn 2 observed');

    expectTextInOrder(output, [
      '🎯 Goal: Finish worker task (turn 1)',
      '🎯 Goal: Finish worker task (turn 2)',
    ]);

    const goal = harness.goal('worker-1');
    expect(goal?.turn_count).toBe(2);
    if (goal?.turn_count !== 2) {
      throw new Error(`unexpected worker turn count\n${trace.dump()}`);
    }
  });

  test.serial('uat: active worker goal suppresses leader completion until goal is done', async () => {
    const trace = new ScenarioTrace();
    const room = getRoom('crew');
    expect(room).toBeDefined();
    const harness = new GoalReminderUATHarness(
      room!.id,
      { leader: leaderPane, 'worker-1': workerPane, 'worker-2': workerTwoPane },
      trace,
    );

    harness.setGoal('worker-1', 'Finish gated worker task', 'worker-1');

    const workerMarker = '=== worker-goal-gated-stop ===';
    const leaderMarker = '=== leader-goal-gated-stop ===';
    await harness.markPane('worker-1', workerMarker, true);
    await harness.markPane('leader', leaderMarker);

    const firstReminder = await waitForPaneOutput(
      harness.pane('worker-1'),
      /🎯 Goal: Finish gated worker task \(turn 1\)/,
      7000,
      async () => {
        await processHookEventInput(
          JSON.stringify({
            hook_event_name: 'Stop',
            session_id: 'worker-goal-gated-stop-1',
            last_assistant_message: 'suppressed while active',
          }),
          harness.pane('worker-1'),
        );
        trace.add('worker Stop #1 fired with active goal');
      },
    );
    expect(firstReminder.matched).toBe(true);
    trace.add('worker reminder observed while leader completion stayed gated');

    await harness.assertNoPaneText('leader', leaderMarker, '[worker-1@crew] completed:', 1800);
    trace.add('confirmed leader did not receive Stop completion while goal was active');

    expect(completeGoal('worker-1', room!.id)).toBe(true);
    trace.add('worker goal marked done');

    const leaderDelivery = await waitForPaneOutput(
      harness.pane('leader'),
      /\[worker-1@crew\] completed:/,
      7000,
      async () => {
        await processHookEventInput(
          JSON.stringify({
            hook_event_name: 'Stop',
            session_id: 'worker-goal-gated-stop-2',
            last_assistant_message: 'delivered after goal done',
          }),
          harness.pane('worker-1'),
        );
        trace.add('worker Stop #2 fired after goal done');
      },
    );
    expect(leaderDelivery.matched).toBe(true);

    const output = await harness.waitForPaneText(
      'leader',
      leaderMarker,
      'delivered after goal done',
      5000,
    );
    trace.add('leader completion observed after goal done');

    expectTextInOrder(output, ['[worker-1@crew] completed:', 'delivered after goal done']);

    const goal = harness.goal('worker-1');
    expect(goal?.status).toBe('done');
    expect(goal?.turn_count).toBe(1);
  });

  test.serial('uat: leader reminder appears only on Stop after queued direct delivery drains', async () => {
    const trace = new ScenarioTrace();
    const room = getRoom('crew');
    expect(room).toBeDefined();
    const harness = new GoalReminderUATHarness(
      room!.id,
      { leader: leaderPane, 'worker-1': workerPane, 'worker-2': workerTwoPane },
      trace,
    );

    harness.setGoal('lead-1', 'Review inbound results', 'leader');

    const marker = '=== leader-direct-uat ===';
    await harness.markPane('leader', marker);

    await deliverMessage('worker-1', 'crew', 'plain completion', 'lead-1', 'pull', 'completion');
    trace.add('worker completion delivered to leader');

    await harness.waitForPaneText('leader', marker, 'plain completion', 5000);
    trace.add('leader completion visible in pane');

    await harness.waitForGoal(
      'lead-1',
      (goal) => goal?.leader_reminder_armed === 1 && goal.turn_count === 0,
      'leader goal never armed after direct delivery',
    );
    trace.add('leader goal armed after queue drain');

    await harness.assertNoPaneText('leader', marker, '🎯 Goal: Review inbound results');
    trace.add('confirmed no leader reminder before Stop');

    await harness.waitForReminderOnStop(
      'leader',
      /🎯 Goal: Review inbound results \(turn 1\)/,
      'leader-stop-1',
      'leader Stop fired',
    );

    const output = await harness.waitForPaneText('leader', marker, '🎯 Goal: Review inbound results (turn 1)');
    trace.add('leader reminder observed');

    expectTextInOrder(output, ['plain completion', '🎯 Goal: Review inbound results (turn 1)']);

    await harness.waitForGoal(
      'lead-1',
      (goal) => goal?.leader_reminder_armed === 0 && goal.turn_count === 1,
      'leader goal never consumed after Stop',
    );
    trace.add('leader goal consume confirmed');
  });

  test.serial('uat: blocked leader delays delivery and reminder arming until unblock flush', async () => {
    const trace = new ScenarioTrace();
    const room = getRoom('crew');
    expect(room).toBeDefined();
    const harness = new GoalReminderUATHarness(
      room!.id,
      { leader: leaderPane, 'worker-1': workerPane, 'worker-2': workerTwoPane },
      trace,
    );

    harness.setGoal('lead-1', 'Review blocked replay', 'leader');

    const marker = '=== leader-blocked-uat ===';
    await harness.markPane('leader', marker);

    setAgentInputBlockMode('lead-1', 'persist');
    trace.add('leader input blocked');

    await deliverMessage('worker-1', 'crew', 'blocked completion', 'lead-1', 'pull', 'completion');
    trace.add('worker completion sent while blocked');

    await harness.assertNoPaneText('leader', marker, 'blocked completion');
    trace.add('confirmed no completion while blocked');

    const blockedGoal = harness.goal('lead-1');
    expect(blockedGoal?.leader_reminder_armed).toBe(0);
    if (blockedGoal?.leader_reminder_armed !== 0) {
      const output = await harness.paneAfterMarker('leader', marker);
      throw new Error(
        `leader reminder armed too early while blocked\n${trace.dump()}\n--- pane ---\n${output}`,
      );
    }

    const unblockResult = await handleInputBlock({ subcommand: 'off', name: 'lead-1' });
    trace.add(`leader unblocked: ${JSON.stringify(unblockResult.content[0])}`);

    await harness.waitForPaneText('leader', marker, 'blocked completion', 5000);
    trace.add('blocked completion delivered after flush');

    await harness.waitForGoal(
      'lead-1',
      (goal) => goal?.leader_reminder_armed === 1 && goal.turn_count === 0,
      'leader goal never armed after unblock flush',
    );
    trace.add('leader goal armed after flush');

    await harness.assertNoPaneText('leader', marker, '🎯 Goal: Review blocked replay');
    trace.add('confirmed no reminder before Stop after unblock');

    await harness.waitForReminderOnStop(
      'leader',
      /🎯 Goal: Review blocked replay \(turn 1\)/,
      'leader-stop-blocked-1',
      'leader Stop fired',
    );

    const output = await harness.waitForPaneText('leader', marker, '🎯 Goal: Review blocked replay (turn 1)');
    trace.add('leader blocked replay reminder observed');

    expectTextInOrder(output, ['blocked completion', '🎯 Goal: Review blocked replay (turn 1)']);

    await harness.waitForGoal(
      'lead-1',
      (goal) => goal?.leader_reminder_armed === 0 && goal.turn_count === 1,
      'leader goal never consumed after blocked replay Stop',
    );
    trace.add('leader blocked replay consume confirmed');
  });

  test.serial('uat: leader reminder is one-shot after direct delivery', async () => {
    const trace = new ScenarioTrace();
    const room = getRoom('crew');
    expect(room).toBeDefined();
    const harness = new GoalReminderUATHarness(
      room!.id,
      { leader: leaderPane, 'worker-1': workerPane, 'worker-2': workerTwoPane },
      trace,
    );

    harness.setGoal('lead-1', 'One-shot direct reminder', 'leader');

    const marker = '=== leader-direct-one-shot-uat ===';
    await harness.markPane('leader', marker);

    await deliverMessage('worker-1', 'crew', 'one-shot completion', 'lead-1', 'pull', 'completion');
    trace.add('worker completion delivered for one-shot test');

    await harness.waitForPaneText('leader', marker, 'one-shot completion', 5000);
    await harness.waitForGoal(
      'lead-1',
      (goal) => goal?.leader_reminder_armed === 1 && goal.turn_count === 0,
      'leader goal never armed for one-shot test',
    );
    trace.add('leader armed for one-shot test');

    await harness.waitForReminderOnStop(
      'leader',
      /🎯 Goal: One-shot direct reminder \(turn 1\)/,
      'leader-stop-one-shot-1',
      'leader Stop #1 fired for one-shot test',
    );

    const firstOutput = await harness.waitForPaneText(
      'leader',
      marker,
      '🎯 Goal: One-shot direct reminder (turn 1)',
    );
    expectTextInOrder(firstOutput, ['one-shot completion', '🎯 Goal: One-shot direct reminder (turn 1)']);
    trace.add('first reminder observed for one-shot test');

    await harness.waitForGoal(
      'lead-1',
      (goal) => goal?.leader_reminder_armed === 0 && goal.turn_count === 1,
      'leader goal never consumed after first Stop in one-shot test',
    );

    await processHookEventInput(
      JSON.stringify({ hook_event_name: 'Stop', session_id: 'leader-stop-one-shot-2' }),
      harness.pane('leader'),
    );
    trace.add('leader Stop #2 fired for one-shot test');

    await harness.assertNoPaneText('leader', marker, '🎯 Goal: One-shot direct reminder (turn 2)', 1800);
    const finalGoal = harness.goal('lead-1');
    expect(finalGoal?.turn_count).toBe(1);
    trace.add('confirmed no second reminder on duplicate Stop');
  });

  test.serial('uat: leader Stop during partial batch completion does not remind early', async () => {
    const trace = new ScenarioTrace();
    const room = getRoom('crew');
    expect(room).toBeDefined();
    const harness = new GoalReminderUATHarness(
      room!.id,
      { leader: leaderPane, 'worker-1': workerPane, 'worker-2': workerTwoPane },
      trace,
    );

    harness.setGoal('lead-1', 'Wait for full batch', 'leader');

    const marker = '=== leader-partial-batch-uat ===';
    await harness.markPane('leader', marker);

    const batchId = makeBatchId('partial-batch');
    createMessageBatch({
      batchId,
      roomId: room!.id,
      leaderName: 'lead-1',
      hintAfterSeconds: null,
      workers: [
        { workerName: 'worker-1', promptFile: 'prompts/a.md' },
        { workerName: 'worker-2', promptFile: 'prompts/b.md' },
      ],
    });
    trace.add(`partial batch created: ${batchId}`);

    await deliverMessage('lead-1', 'crew', 'partial task 1', 'worker-1', 'pull', 'task', undefined, {
      batch_id: batchId,
      worker_name: 'worker-1',
      prompt_file: 'prompts/a.md',
      manifest_order: 0,
    });
    await deliverMessage('lead-1', 'crew', 'partial task 2', 'worker-2', 'pull', 'task', undefined, {
      batch_id: batchId,
      worker_name: 'worker-2',
      prompt_file: 'prompts/b.md',
      manifest_order: 1,
    });

    await deliverMessage('worker-1', 'crew', 'partial alpha final', 'lead-1', 'pull', 'completion', undefined, {
      batch_id: batchId,
    });
    trace.add('worker-1 partial completion recorded');

    await harness.assertNoPaneText('leader', marker, '## worker-1', 1500);
    const partialGoal = harness.goal('lead-1');
    expect(partialGoal?.leader_reminder_armed).toBe(0);
    trace.add('confirmed no leader arm after only one batch completion');

    await processHookEventInput(
      JSON.stringify({ hook_event_name: 'Stop', session_id: 'leader-stop-partial-batch-1' }),
      harness.pane('leader'),
    );
    trace.add('leader Stop fired during partial batch');

    await harness.assertNoPaneText('leader', marker, '🎯 Goal: Wait for full batch', 1800);
    const afterPartialStop = harness.goal('lead-1');
    expect(afterPartialStop?.turn_count).toBe(0);
    expect(afterPartialStop?.leader_reminder_armed).toBe(0);
    trace.add('confirmed partial-batch Stop does not consume or remind');
  });

  test.serial('uat: batch final delivery arms leader reminder only after final summary drain', async () => {
    const trace = new ScenarioTrace();
    const room = getRoom('crew');
    expect(room).toBeDefined();
    const harness = new GoalReminderUATHarness(
      room!.id,
      { leader: leaderPane, 'worker-1': workerPane, 'worker-2': workerTwoPane },
      trace,
    );

    harness.setGoal('lead-1', 'Review batch results', 'leader');

    const marker = '=== leader-batch-uat ===';
    await harness.markPane('leader', marker);

    const batchId = makeBatchId('uat-batch');
    createMessageBatch({
      batchId,
      roomId: room!.id,
      leaderName: 'lead-1',
      hintAfterSeconds: null,
      workers: [
        { workerName: 'worker-1', promptFile: 'prompts/a.md' },
        { workerName: 'worker-2', promptFile: 'prompts/b.md' },
      ],
    });
    trace.add(`batch created: ${batchId}`);

    await deliverMessage('lead-1', 'crew', 'task for worker-1', 'worker-1', 'pull', 'task', undefined, {
      batch_id: batchId,
      worker_name: 'worker-1',
      prompt_file: 'prompts/a.md',
      manifest_order: 0,
    });
    await deliverMessage('lead-1', 'crew', 'task for worker-2', 'worker-2', 'pull', 'task', undefined, {
      batch_id: batchId,
      worker_name: 'worker-2',
      prompt_file: 'prompts/b.md',
      manifest_order: 1,
    });
    trace.add('batch task fan-out recorded');

    await deliverMessage('worker-1', 'crew', 'alpha final', 'lead-1', 'pull', 'completion', undefined, {
      batch_id: batchId,
    });
    trace.add('worker-1 terminal completion recorded');

    await harness.assertNoPaneText('leader', marker, '## worker-1', 1500);
    const partialGoal = harness.goal('lead-1');
    expect(partialGoal?.leader_reminder_armed).toBe(0);
    trace.add('confirmed no batch final output or leader arm after partial completion');

    await deliverMessage('worker-2', 'crew', 'bravo final', 'lead-1', 'pull', 'completion', undefined, {
      batch_id: batchId,
    });
    trace.add('worker-2 terminal completion recorded');

    const output = await harness.waitForPaneText('leader', marker, '## worker-2');
    trace.add('final batch summary observed in leader pane');

    expectTextInOrder(output, ['## worker-1', 'alpha final', '## worker-2', 'bravo final']);

    await harness.waitForGoal(
      'lead-1',
      (goal) => goal?.leader_reminder_armed === 1 && goal.turn_count === 0,
      'leader goal never armed after batch final drain',
    );
    trace.add('leader goal armed after batch final drain');

    await harness.assertNoPaneText('leader', marker, '🎯 Goal: Review batch results');
    trace.add('confirmed no leader reminder before Stop after batch final');

    await harness.waitForReminderOnStop(
      'leader',
      /🎯 Goal: Review batch results \(turn 1\)/,
      'leader-stop-batch-1',
      'leader Stop fired for batch path',
    );

    const finalOutput = await harness.waitForPaneText('leader', marker, '🎯 Goal: Review batch results (turn 1)');
    trace.add('leader batch reminder observed');

    expectTextInOrder(finalOutput, [
      '## worker-1',
      'alpha final',
      '## worker-2',
      'bravo final',
      '🎯 Goal: Review batch results (turn 1)',
    ]);

    await harness.waitForGoal(
      'lead-1',
      (goal) => goal?.leader_reminder_armed === 0 && goal.turn_count === 1,
      'leader goal never consumed after batch Stop',
    );
    trace.add('leader batch consume confirmed');
  });
});
