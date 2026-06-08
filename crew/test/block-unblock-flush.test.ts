import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { closeDb, initDb } from '../src/state/db.ts';
import { handleJoinRoom } from '../src/tools/join-room.ts';
import { handleSendMessage } from '../src/tools/send-message.ts';
import { setAgentInputBlockMode } from '../src/state/index.ts';
import {
  captureFromPane,
  cleanupAllTestSessions,
  createTestSession,
} from './helpers.ts';

setDefaultTimeout(15000);

describe('Block Unblock Flush', () => {
  let testPaneA: string;
  let testPaneB: string;
  let sessionA: string;
  let sessionB: string;

  beforeEach(async () => {
    initDb(':memory:');
    const sa = await createTestSession('flush-a');
    testPaneA = sa.pane;
    sessionA = sa.session;

    const sb = await createTestSession('flush-b');
    testPaneB = sb.pane;
    sessionB = sb.session;
  });

  afterEach(async () => {
    await cleanupAllTestSessions();
    closeDb();
  });

  test('queued messages are flushed to leader when unblocked', async () => {
    // 1. Join room
    await handleJoinRoom({
      room: 'company',
      role: 'leader',
      name: 'leader-1',
      tmux_target: testPaneA,
    });
    await handleJoinRoom({
      room: 'company',
      role: 'worker',
      name: 'worker-1',
      tmux_target: testPaneB,
    });

    // 2. Set input block to persist on leader
    setAgentInputBlockMode('leader-1', 'persist');

    // 3. Worker sends a message to leader (this should be queued/deferred)
    await handleSendMessage({
      room: 'company',
      name: 'worker-1',
      text: 'Message-Sent-While-Blocked',
      to: 'leader-1',
      mode: 'pull',
      kind: 'completion',
    });

    // Wait a bit to ensure it is NOT delivered while blocked
    await Bun.sleep(1000);
    let leaderOutput = await captureFromPane(testPaneA);
    expect(leaderOutput).not.toContain('Message-Sent-While-Blocked');

    // 4. Unblock the leader
    setAgentInputBlockMode('leader-1', 'off');

    // 5. Trigger the flush/sweep process
    const { flushPushQueue } = await import('../src/delivery/index.ts');
    await flushPushQueue();

    // Wait a bit for tmux delivery
    await Bun.sleep(1000);

    // 6. Verify that the message is now delivered
    leaderOutput = await captureFromPane(testPaneA);
    expect(leaderOutput).toContain('Message-Sent-While-Blocked');
  });

  test('queued Stop hook event notifications are flushed to leader when unblocked', async () => {
    // 1. Join room
    await handleJoinRoom({
      room: 'company',
      role: 'leader',
      name: 'leader-1',
      tmux_target: testPaneA,
    });
    await handleJoinRoom({
      room: 'company',
      role: 'worker',
      name: 'worker-1',
      tmux_target: testPaneB,
    });

    // 2. Set input block to persist on leader
    setAgentInputBlockMode('leader-1', 'persist');

    // 3. Worker stops (sends Stop hook event)
    const { processHookEventInput } = await import('../src/tools/hook-event.ts');
    await processHookEventInput(
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'sess-worker-stop-flush',
        last_assistant_message: 'Worker finished task successfully',
      }),
      testPaneB,
    );

    // Wait a bit to ensure it is NOT delivered while blocked
    await Bun.sleep(1000);
    let leaderOutput = await captureFromPane(testPaneA);
    expect(leaderOutput).not.toContain('Worker finished task successfully');

    // 4. Unblock the leader
    setAgentInputBlockMode('leader-1', 'off');

    // 5. Trigger the flush/sweep process
    const { flushPushQueue } = await import('../src/delivery/index.ts');
    await flushPushQueue();

    // Wait a bit for tmux delivery
    await Bun.sleep(1000);

    // 6. Verify that the message is now delivered
    leaderOutput = await captureFromPane(testPaneA);
    expect(leaderOutput).toContain('Worker finished task successfully');
  });
});
