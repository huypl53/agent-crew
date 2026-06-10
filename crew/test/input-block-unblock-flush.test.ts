import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { closeDb, initDb } from '../src/state/db.ts';
import { setAgentInputBlockMode } from '../src/state/index.ts';
import { handleInputBlock } from '../src/tools/input-block.ts';
import { handleJoinRoom } from '../src/tools/join-room.ts';
import { handleSendMessage } from '../src/tools/send-message.ts';
import {
  captureFromPane,
  cleanupAllTestSessions,
  createTestSession,
} from './helpers.ts';

setDefaultTimeout(15000);

describe('Input Block Unblock Auto-Flush', () => {
  let testPaneA: string;
  let testPaneB: string;
  let _sessionA: string;
  let _sessionB: string;

  beforeEach(async () => {
    initDb(':memory:');
    const sa = await createTestSession('ibflush-a');
    testPaneA = sa.pane;
    _sessionA = sa.session;

    const sb = await createTestSession('ibflush-b');
    testPaneB = sb.pane;
    _sessionB = sb.session;
  });

  afterEach(async () => {
    await cleanupAllTestSessions();
    closeDb();
  });

  test('crew unblock automatically flushes pending push messages to leader', async () => {
    // 1. Join room
    await handleJoinRoom({
      room: 'flush-room',
      role: 'leader',
      name: 'leader-1',
      tmux_target: testPaneA,
    });
    await handleJoinRoom({
      room: 'flush-room',
      role: 'worker',
      name: 'worker-1',
      tmux_target: testPaneB,
    });

    // 2. Block the leader
    setAgentInputBlockMode('leader-1', 'persist');

    // 3. Worker sends a push message to the leader — should be queued, not delivered
    await handleSendMessage({
      room: 'flush-room',
      name: 'worker-1',
      text: 'AutoFlushTest-QueuedMessage',
      to: 'leader-1',
      mode: 'push',
      kind: 'completion',
    });

    // Wait a bit to ensure it's NOT delivered while blocked
    await Bun.sleep(500);
    let leaderOutput = await captureFromPane(testPaneA);
    expect(leaderOutput).not.toContain('AutoFlushTest-QueuedMessage');

    // 4. Unblock the leader via handleInputBlock — this should auto-flush
    const result = await handleInputBlock({
      subcommand: 'off',
      name: 'leader-1',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.input_block_mode).toBe('off');

    // Wait a bit for tmux delivery
    await Bun.sleep(1000);

    // 5. Verify the queued message is now delivered
    leaderOutput = await captureFromPane(testPaneA);
    expect(leaderOutput).toContain('AutoFlushTest-QueuedMessage');
  });

  test('crew unblock auto-flush includes completion from worker Stop hook', async () => {
    // 1. Join room
    await handleJoinRoom({
      room: 'hook-flush-room',
      role: 'leader',
      name: 'leader-1',
      tmux_target: testPaneA,
    });
    await handleJoinRoom({
      room: 'hook-flush-room',
      role: 'worker',
      name: 'worker-1',
      tmux_target: testPaneB,
    });

    // 2. Block the leader
    setAgentInputBlockMode('leader-1', 'persist');

    // 3. Worker stops (fires Stop hook event) — creates completion message
    const { processHookEventInput } = await import(
      '../src/tools/hook-event.ts'
    );
    await processHookEventInput(
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'sess-auto-flush-stop',
        last_assistant_message: 'AutoFlushStop-WorkerCompleted',
      }),
      testPaneB,
    );

    // Wait a bit to ensure it's NOT delivered while blocked
    await Bun.sleep(500);
    let leaderOutput = await captureFromPane(testPaneA);
    expect(leaderOutput).not.toContain('AutoFlushStop-WorkerCompleted');

    // 4. Unblock the leader — this should auto-flush and deliver the completion
    await handleInputBlock({
      subcommand: 'off',
      name: 'leader-1',
    });

    // Wait for tmux delivery
    await Bun.sleep(1000);

    // 5. Verify the completion message is delivered
    leaderOutput = await captureFromPane(testPaneA);
    expect(leaderOutput).toContain('AutoFlushStop-WorkerCompleted');
  });

  test('crew unblock reports flushed_messages count', async () => {
    // 1. Join room
    await handleJoinRoom({
      room: 'flush-count-room',
      role: 'leader',
      name: 'leader-1',
      tmux_target: testPaneA,
    });
    await handleJoinRoom({
      room: 'flush-count-room',
      role: 'worker',
      name: 'worker-1',
      tmux_target: testPaneB,
    });

    // 2. Block the leader
    setAgentInputBlockMode('leader-1', 'persist');

    // 3. Send a push message
    await handleSendMessage({
      room: 'flush-count-room',
      name: 'worker-1',
      text: 'FlushCountTest',
      to: 'leader-1',
      mode: 'push',
      kind: 'completion',
    });

    // 4. Unblock — should report flushed_messages
    const result = await handleInputBlock({
      subcommand: 'off',
      name: 'leader-1',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.input_block_mode).toBe('off');
    expect(data.flushed_messages).toBeGreaterThanOrEqual(1);
  });
});
