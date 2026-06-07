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

describe('Block Delivery Bug Reproduction', () => {
  let testPaneA: string;
  let testPaneB: string;
  let sessionA: string;
  let sessionB: string;

  beforeEach(async () => {
    initDb(':memory:');
    const sa = await createTestSession('block-a');
    testPaneA = sa.pane;
    sessionA = sa.session;

    const sb = await createTestSession('block-b');
    testPaneB = sb.pane;
    sessionB = sb.session;
  });

  afterEach(async () => {
    await cleanupAllTestSessions();
    closeDb();
  });

  test('incoming message from worker is not delivered to leader when blocked', async () => {
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

    // 3. Worker sends a message to leader
    const result = await handleSendMessage({
      room: 'company',
      name: 'worker-1',
      text: 'Hello Leader',
      to: 'leader-1',
      mode: 'pull',
      kind: 'completion',
    });

    console.log('SendMessage Result:', JSON.stringify(result));

    // Wait a bit to see if tmux would have pasted it
    await Bun.sleep(1000);

    const leaderOutput = await captureFromPane(testPaneA);
    console.log('Leader Pane Output:', leaderOutput);

    expect(leaderOutput).not.toContain('Hello Leader');
  });

  test('worker Stop hook notification is not delivered to leader when blocked', async () => {
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
        session_id: 'sess-worker-stop',
        last_assistant_message: 'Worker finished task successfully',
      }),
      testPaneB,
    );

    // Wait a bit to see if tmux would have pasted it
    await Bun.sleep(1000);

    const leaderOutput = await captureFromPane(testPaneA);
    console.log('Leader Pane Output with Stop Hook:', leaderOutput);

    expect(leaderOutput).not.toContain('Worker finished task successfully');
  });

  test('party digest is not delivered to leader when blocked', async () => {
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

    // 3. Start party mode
    const { handleParty } = await import('../src/tools/party.ts');
    await handleParty({
      subcommand: 'start',
      name: 'leader-1',
      topic: 'Evaluate new strategy',
    });

    // 4. Worker responds (fires Stop hook)
    const { processHookEventInput } = await import('../src/tools/hook-event.ts');
    await processHookEventInput(
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'sess-party-1',
        last_assistant_message: 'Worker perspective on strategy',
      }),
      testPaneB,
    );

    // Wait a bit to see if tmux would have pasted it
    await Bun.sleep(1000);

    const leaderOutput = await captureFromPane(testPaneA);
    console.log('Leader Pane Output with Party Digest:', leaderOutput);

    expect(leaderOutput).not.toContain('Worker perspective on strategy');
  });
});
