import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { config } from '../src/config.ts';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  addAgent,
  clearState,
  getOrCreateRoom,
  getRoom,
  getSweepControlState,
  setSweepBusyMode,
  setSweepPaused,
} from '../src/state/index.ts';
import { handleClearWorkerSession } from '../src/tools/clear-worker-session.ts';
import { handleGetStatus } from '../src/tools/get-status.ts';
import { processHookEventInput } from '../src/tools/hook-event.ts';
import { handleInputBlock } from '../src/tools/input-block.ts';
import { handleInspectWorker } from '../src/tools/inspect-worker.ts';
import { handleInterruptWorker } from '../src/tools/interrupt-worker.ts';
import { handleJoinRoom } from '../src/tools/join-room.ts';
import { handleLeaveRoom } from '../src/tools/leave-room.ts';
import { handleListMembers } from '../src/tools/list-members.ts';
import { handleListRooms } from '../src/tools/list-rooms.ts';
import {
  handlePausePolling,
  handlePollingStatus,
  handleResumePolling,
  handleSetPollingBusy,
} from '../src/tools/polling-control.ts';
import { handleReadMessages } from '../src/tools/read-messages.ts';
import { handleReassignTask } from '../src/tools/reassign-task.ts';
import { handleRefresh } from '../src/tools/refresh.ts';
import { handleSendMessage } from '../src/tools/send-message.ts';
import { handleSetRoomTopic } from '../src/tools/set-room-topic.ts';
import {
  captureFromPane,
  cleanupAllTestSessions,
  createTestSession,
  destroyTestSession,
  getCallerTestTag,
} from './helpers.ts';

// Use fast polling so waitForReady() resolves well within default test timeouts
config.pollingProfile = 'conservative';

let testPaneA: string;
let testPaneB: string;
let sessionSeq = 0;
const originalSenderVerification = config.senderVerification;
config.senderVerification = 'off';

function mkRoom(name: string) {
  return getOrCreateRoom(`/test/${name}`, name);
}

describe('MCP tools', () => {
  beforeEach(async () => {
    initDb(':memory:');
    sessionSeq += 1;
    const a = await createTestSession(`tools-a-${sessionSeq}`);
    const b = await createTestSession(`tools-b-${sessionSeq}`);
    testPaneA = a.pane;
    testPaneB = b.pane;
  });

  afterEach(() => {
    delete process.env.TMUX_PANE;
  });

  afterAll(async () => {
    config.senderVerification = originalSenderVerification;
    await cleanupAllTestSessions(getCallerTestTag());
    closeDb();
  });

  describe('join_room', () => {
    test('registers agent with valid params', async () => {
      const result = await handleJoinRoom({
        room: 'company',
        role: 'leader',
        name: 'leader-1',
        tmux_target: testPaneA,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]?.text);
      expect(data.name).toBe('leader-1');
      expect(data.role).toBe('leader');
      expect(data.room).toBe('company');
    });

    test('generates random name when not provided', async () => {
      const result = await handleJoinRoom({
        room: 'company',
        role: 'worker',
        tmux_target: testPaneA,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]?.text);
      expect(data.name).toMatch(/^worker-agent-[a-z0-9]{4}$/);
    });

    test('generates random name when empty string', async () => {
      const result = await handleJoinRoom({
        room: 'company',
        role: 'worker',
        name: '',
        tmux_target: testPaneA,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]?.text);
      expect(data.name).toMatch(/^worker-agent-[a-z0-9]{4}$/);
    });

    test('rejoin same name same pane updates in place', async () => {
      await handleJoinRoom({
        room: 'company',
        role: 'worker',
        name: 'agent-x',
        tmux_target: testPaneA,
      });
      const result = await handleJoinRoom({
        room: 'company',
        role: 'leader',
        name: 'agent-x',
        tmux_target: testPaneA,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]?.text);
      expect(data.name).toBe('agent-x');
      expect(data.role).toBe('leader');
    });

    test('adds suffix for duplicate name in same room with different pane', async () => {
      await handleJoinRoom({
        room: 'company',
        role: 'leader',
        name: 'leader-1',
        tmux_target: testPaneA,
      });
      const result = await handleJoinRoom({
        room: 'company',
        role: 'worker',
        name: 'leader-1',
        tmux_target: testPaneB,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]?.text);
      expect(data.name).toMatch(/^leader-1-[a-z0-9]{4}$/);
    });

    test('allows same agent in multiple rooms', async () => {
      await handleJoinRoom({
        room: 'company',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      const result = await handleJoinRoom({
        room: 'frontend',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      expect(result.isError).toBeUndefined();
    });

    test('rejects invalid role', async () => {
      const result = await handleJoinRoom({
        room: 'r',
        role: 'admin',
        name: 'n',
        tmux_target: testPaneA,
      });
      expect(result.isError).toBe(true);
    });

    test('rejects non-existent pane', async () => {
      const result = await handleJoinRoom({
        room: 'r',
        role: 'worker',
        name: 'n',
        tmux_target: '%99999',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('leave_room', () => {
    test('removes agent from room', async () => {
      await handleJoinRoom({
        room: 'company',
        role: 'leader',
        name: 'leader-1',
        tmux_target: testPaneA,
      });
      const result = await handleLeaveRoom({
        room: 'company',
        name: 'leader-1',
      });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.success).toBe(true);
    });

    test('errors when not in room', async () => {
      await handleJoinRoom({
        room: 'company',
        role: 'leader',
        name: 'leader-1',
        tmux_target: testPaneA,
      });
      const result = await handleLeaveRoom({
        room: 'frontend',
        name: 'leader-1',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('list_rooms', () => {
    test('lists all rooms with counts', async () => {
      await handleJoinRoom({
        room: 'company',
        role: 'leader',
        name: 'leader-1',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'company',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneB,
      });
      const result = await handleListRooms();
      const data = JSON.parse(result.content[0]?.text);
      expect(data.rooms.length).toBe(1);
      expect(data.rooms[0].name).toBe('company');
      expect(data.rooms[0].member_count).toBe(2);
      expect(data.rooms[0].roles.leader).toBe(2);
    });
  });

  describe('list_members', () => {
    test('lists members of a room', async () => {
      await handleJoinRoom({
        room: 'company',
        role: 'leader',
        name: 'leader-1',
        tmux_target: testPaneA,
      });
      const result = await handleListMembers({ room: 'company' });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.members.length).toBe(1);
      expect(data.members[0].name).toBe('leader-1');
      expect(data.members[0].input_block_mode).toBe('off');
    });

    test('errors for non-existent room', async () => {
      const result = await handleListMembers({ room: 'nope' });
      expect(result.isError).toBe(true);
    });

    test('reports current status and input block mode', async () => {
      await handleJoinRoom({
        room: 'company',
        role: 'worker',
        name: 'worker-1',
        tmux_target: testPaneA,
      });

      process.env.TMUX_PANE = testPaneA;
      await handleInputBlock({ subcommand: 'on', persist: true });

      await processHookEventInput(
        JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'sess-members',
        }),
        testPaneA,
      );

      const result = await handleListMembers({ room: 'company' });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.members[0].status).toBe('busy');
      expect(data.members[0].input_block_mode).toBe('persist');
    });
  });

  describe('input_block', () => {
    test('auto-detects current pane and clears armed mode on next submit', async () => {
      await handleJoinRoom({
        room: 'company',
        role: 'worker',
        name: 'worker-1',
        tmux_target: testPaneA,
      });

      process.env.TMUX_PANE = testPaneA;
      const onResult = await handleInputBlock({ subcommand: 'on' });
      const onData = JSON.parse(onResult.content[0]!.text);
      expect(onData.input_block_mode).toBe('armed');

      await processHookEventInput(
        JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'sess-armed',
        }),
        testPaneA,
      );

      const statusResult = await handleInputBlock({ subcommand: 'status' });
      const statusData = JSON.parse(statusResult.content[0]!.text);
      expect(statusData.input_block_mode).toBe('off');
    });

    test('persistent mode survives submit until manual off', async () => {
      await handleJoinRoom({
        room: 'company',
        role: 'worker',
        name: 'worker-1',
        tmux_target: testPaneA,
      });

      process.env.TMUX_PANE = testPaneA;
      const onResult = await handleInputBlock({
        subcommand: 'on',
        persist: true,
      });
      const onData = JSON.parse(onResult.content[0]!.text);
      expect(onData.input_block_mode).toBe('persist');

      await processHookEventInput(
        JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'sess-persist',
        }),
        testPaneA,
      );

      const statusResult = await handleInputBlock({ subcommand: 'status' });
      const statusData = JSON.parse(statusResult.content[0]!.text);
      expect(statusData.input_block_mode).toBe('persist');

      const offResult = await handleInputBlock({ subcommand: 'off' });
      const offData = JSON.parse(offResult.content[0]!.text);
      expect(offData.input_block_mode).toBe('off');
    });
  });

  describe('messaging', () => {
    test('send and read directed push message', async () => {
      await handleJoinRoom({
        room: 'frontend',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'frontend',
        role: 'worker',
        name: 'builder-1',
        tmux_target: testPaneB,
      });

      const sendResult = await handleSendMessage({
        room: 'frontend',
        text: 'Build the login page',
        to: 'builder-1',
        name: 'lead-1',
      });
      const sendData = JSON.parse(sendResult.content[0]!.text);
      expect(sendData.queued).toBe(true);
      expect(sendData.delivered).toBe(true);

      const readResult = await handleReadMessages({ name: 'builder-1' });
      const readData = JSON.parse(readResult.content[0]!.text);
      expect(readData.messages.length).toBe(1);
      expect(readData.messages[0].text).toBe('Build the login page');
      expect(readData.messages[0].from).toBe('lead-1');
    });

    test('read_messages returns no messages when input block is active', async () => {
      await handleJoinRoom({
        room: 'frontend',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'frontend',
        role: 'worker',
        name: 'builder-1',
        tmux_target: testPaneB,
      });

      // 1. Send a message to builder-1 (normally delivered/queued)
      await handleSendMessage({
        room: 'frontend',
        text: 'Hello builder',
        to: 'builder-1',
        name: 'lead-1',
        mode: 'pull', // use pull so we don't block on tmux pane delivery
      });

      // 2. Enable input block (persist)
      const { setAgentInputBlockMode } = await import('../src/state/index.ts');
      setAgentInputBlockMode('builder-1', 'persist');

      // 3. Try reading messages — should return empty list
      const readResult1 = await handleReadMessages({
        name: 'builder-1',
        room: 'frontend',
      });
      const readData1 = JSON.parse(readResult1.content[0]!.text);
      expect(readData1.messages.length).toBe(0);

      // 4. Disable input block
      setAgentInputBlockMode('builder-1', 'off');

      // 5. Try reading messages — should return the message now
      const readResult2 = await handleReadMessages({
        name: 'builder-1',
        room: 'frontend',
      });
      const readData2 = JSON.parse(readResult2.content[0]!.text);
      expect(readData2.messages.length).toBe(1);
      expect(readData2.messages[0].text).toBe('Hello builder');
    });

    test('pull message is queued but not delivered', async () => {
      await handleJoinRoom({
        room: 'frontend',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'frontend',
        role: 'worker',
        name: 'builder-1',
        tmux_target: testPaneB,
      });

      const result = await handleSendMessage({
        room: 'frontend',
        text: 'Task complete',
        to: 'lead-1',
        name: 'builder-1',
        mode: 'pull',
      });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.queued).toBe(true);
      expect(data.delivered).toBe(false);
    });

    test('broadcast message reaches all members except sender', async () => {
      await handleJoinRoom({
        room: 'team',
        role: 'leader',
        name: 'lead',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'team',
        role: 'worker',
        name: 'w1',
        tmux_target: testPaneB,
      });

      await handleSendMessage({ room: 'team', text: 'Stand by', name: 'lead' });

      const readW1 = await handleReadMessages({ name: 'w1', room: 'team' });
      expect(readW1.isError).toBeUndefined();
      const w1Data = JSON.parse(readW1.content[0]!.text);
      expect(Array.isArray(w1Data.messages)).toBe(true);

      // Sender should not receive a directed copy of their own broadcast
      const readLead = await handleReadMessages({ name: 'lead' });
      const leadData = JSON.parse(readLead.content[0]!.text);
      expect(Array.isArray(leadData.messages)).toBe(true);
      expect(leadData.messages.some((m: any) => m.text === 'Stand by')).toBe(
        false,
      );
    });

    test('cursor-based read_messages', async () => {
      await handleJoinRoom({
        room: 'r',
        role: 'worker',
        name: 'a',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'r',
        role: 'leader',
        name: 'b',
        tmux_target: testPaneB,
      });

      await handleSendMessage({
        room: 'r',
        text: 'msg1',
        to: 'a',
        name: 'b',
        mode: 'pull',
      });
      await handleSendMessage({
        room: 'r',
        text: 'msg2',
        to: 'a',
        name: 'b',
        mode: 'pull',
      });

      const first = await handleReadMessages({ name: 'a', room: 'r' });
      const firstData = JSON.parse(first.content[0]!.text);
      expect(firstData.messages.length).toBe(2);

      await handleSendMessage({
        room: 'r',
        text: 'msg3',
        to: 'a',
        name: 'b',
        mode: 'pull',
      });

      const second = await handleReadMessages({ name: 'a', room: 'r' });
      const secondData = JSON.parse(second.content[0]!.text);
      expect(secondData.messages.length).toBe(1);
      expect(secondData.messages[0].text).toBe('msg3');
    }, 15000);

    test('room-filtered read_messages', async () => {
      await handleJoinRoom({
        room: 'r1',
        role: 'worker',
        name: 'a',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'r1',
        role: 'leader',
        name: 'b',
        tmux_target: testPaneB,
      });

      await handleSendMessage({
        room: 'r1',
        text: 'hello r1',
        to: 'a',
        name: 'b',
      });

      const result = await handleReadMessages({ name: 'a', room: 'r1' });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.messages.length).toBe(1);
      expect(data.messages[0].room_id).toBeDefined();
    });

    test('read_messages with room reads inbox for that room only', async () => {
      await handleJoinRoom({
        room: 'frontend',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'frontend',
        role: 'worker',
        name: 'w1',
        tmux_target: testPaneB,
      });

      // leader sends directed message to w1
      await handleSendMessage({
        room: 'frontend',
        text: 'build login',
        to: 'w1',
        name: 'lead-1',
      });

      // lead-1 cannot read w1-directed inbox entries via room-scoped read
      const result = await handleReadMessages({
        name: 'lead-1',
        room: 'frontend',
      });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.messages.length).toBe(0);

      const workerResult = await handleReadMessages({
        name: 'w1',
        room: 'frontend',
      });
      const workerData = JSON.parse(workerResult.content[0]?.text);
      expect(workerData.messages.length).toBe(1);
      expect(workerData.messages[0].text).toBe('build login');
    });

    test('read_messages with kinds filter', async () => {
      await handleJoinRoom({
        room: 'r',
        role: 'leader',
        name: 'lead',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'r',
        role: 'worker',
        name: 'w1',
        tmux_target: testPaneB,
      });

      await handleSendMessage({
        room: 'r',
        text: 'build it',
        to: 'w1',
        name: 'lead',
        kind: 'task',
      });
      await handleSendMessage({
        room: 'r',
        text: 'done!',
        to: 'lead',
        name: 'w1',
        kind: 'completion',
        mode: 'pull',
      });

      const result = await handleReadMessages({
        name: 'lead',
        room: 'r',
        kinds: ['completion'],
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]?.text);
      expect(data.messages.length).toBeGreaterThanOrEqual(1);
      expect(data.messages.some((m: any) => m.kind === 'completion')).toBe(
        true,
      );
    });

    test('worker completion auto-notifies leader via push', async () => {
      await handleJoinRoom({
        room: 'frontend',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'frontend',
        role: 'worker',
        name: 'w1',
        tmux_target: testPaneB,
      });

      // worker sends pull completion to leader
      await handleSendMessage({
        room: 'frontend',
        text: 'Login component done',
        to: 'lead-1',
        name: 'w1',
        mode: 'pull',
        kind: 'completion',
      });

      // Verify push was sent to leader's pane.
      // Notification is fire-and-forget via the queue; waitForReady() needs
      // 2 stable polls at 500ms = 1000ms, plus paste+verify ~800ms.
      await Bun.sleep(2500);
      const captured = await captureFromPane(testPaneA);
      expect(typeof captured).toBe('string');
    }, 15000);

    test('send_message with kind=task sends an assignment without task metadata', async () => {
      await handleJoinRoom({
        room: 'frontend',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'frontend',
        role: 'worker',
        name: 'builder-1',
        tmux_target: testPaneB,
      });

      const result = await handleSendMessage({
        room: 'frontend',
        text: 'Build the login page with validation',
        to: 'builder-1',
        name: 'lead-1',
        kind: 'task',
      });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.message_id).toBeDefined();
      expect(data.task_id).toBeUndefined();
    });

    test('send_message with kind=task requires to param', async () => {
      await handleJoinRoom({
        room: 'frontend',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'frontend',
        role: 'worker',
        name: 'builder-1',
        tmux_target: testPaneB,
      });

      const result = await handleSendMessage({
        room: 'frontend',
        text: 'Build something',
        name: 'lead-1',
        kind: 'task',
      });
      expect(result.isError).toBe(true);
    });

    test('parallel broadcast delivers to all members', async () => {
      // Use pull mode so delivery is DB-only (no pane queue timing issues).
      // Verifies that Promise.allSettled parallel delivery produces correct results
      // for every recipient, not just the first.
      await handleJoinRoom({
        room: 'parallel-test',
        role: 'leader',
        name: 'lead',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'parallel-test',
        role: 'worker',
        name: 'w1',
        tmux_target: testPaneB,
      });
      // Get the room created by join-room (based on test pane CWD)
      const room = getRoom('parallel-test')!;
      // Add w2/w3 directly via addAgent (fake panes, pull-only)
      addAgent('w2', 'worker', room.id, '%99991', 'unknown');
      addAgent('w3', 'worker', room.id, '%99992', 'unknown');

      // Broadcast from lead to w1 + w2 + w3 (pull mode = instant, no pane delivery)
      const result = await handleSendMessage({
        room: 'parallel-test',
        text: 'Hello team',
        name: 'lead',
        mode: 'pull',
      });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.broadcast).toBe(true);
      expect(data.recipients).toBe(3);
      expect(data.delivered).toBe(0); // pull mode
      expect(data.queued).toBe(3);

      // Verify each worker can read the message
      const w1Read = await handleReadMessages({
        name: 'w1',
        room: 'parallel-test',
      });
      const w1Data = JSON.parse(w1Read.content[0]!.text);
      expect(w1Data.messages.length).toBeGreaterThanOrEqual(1);
      expect(w1Data.messages.some((m: any) => m.text === 'Hello team')).toBe(
        true,
      );

      const w2Read = await handleReadMessages({
        name: 'w2',
        room: 'parallel-test',
      });
      const w2Data = JSON.parse(w2Read.content[0]!.text);
      expect(w2Data.messages.length).toBeGreaterThanOrEqual(1);
      expect(w2Data.messages.some((m: any) => m.text === 'Hello team')).toBe(
        true,
      );

      const w3Read = await handleReadMessages({
        name: 'w3',
        room: 'parallel-test',
      });
      const w3Data = JSON.parse(w3Read.content[0]!.text);
      expect(w3Data.messages.length).toBeGreaterThanOrEqual(1);
      expect(w3Data.messages.some((m: any) => m.text === 'Hello team')).toBe(
        true,
      );
    });
  });

  describe('set_room_topic', () => {
    test('sets and retrieves room topic', async () => {
      await handleJoinRoom({
        room: 'frontend',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      const result = await handleSetRoomTopic({
        room: 'frontend',
        text: 'Build auth system',
        name: 'lead-1',
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]?.text);
      expect(data.topic).toBe('Build auth system');

      // Verify it shows in list_members
      const members = await handleListMembers({ room: 'frontend' });
      const membersData = JSON.parse(members.content[0]!.text);
      expect(membersData.topic).toBe('Build auth system');
    });

    test('rejects non-member setting topic', async () => {
      await handleJoinRoom({
        room: 'frontend',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      const result = await handleSetRoomTopic({
        room: 'frontend',
        text: 'Hack',
        name: 'outsider',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('duplicate room names across paths', () => {
    test('list_members prefers the latest matching room row', async () => {
      const firstRoom = getOrCreateRoom(
        '/test/worktree-a/better-logging',
        'better-logging',
      );
      const secondRoom = getOrCreateRoom(
        '/test/worktree-b/better-logging',
        'better-logging',
      );

      addAgent('old-worker', 'worker', firstRoom.id, '%9001');
      addAgent('new-leader', 'leader', secondRoom.id, '%9002');
      addAgent('new-worker', 'worker', secondRoom.id, '%9003');

      const result = await handleListMembers({ room: 'better-logging' });
      const data = JSON.parse(result.content[0]!.text);

      expect(data.members.map((member: any) => member.name).sort()).toEqual([
        'new-leader',
        'new-worker',
      ]);
    });

    test('inspect requires --room when worker is visible in multiple room ids with the same name', async () => {
      const firstRoom = getOrCreateRoom(
        '/test/worktree-a/better-logging',
        'better-logging',
      );
      const secondRoom = getOrCreateRoom(
        '/test/worktree-b/better-logging',
        'better-logging',
      );

      addAgent('lead-1', 'leader', firstRoom.id, '%9010');
      addAgent('shared-worker', 'worker', firstRoom.id, '%9011');
      addAgent('lead-1', 'leader', secondRoom.id, '%9012');
      addAgent('shared-worker', 'worker', secondRoom.id, '%9013');

      const result = await handleInspectWorker({
        worker_name: 'shared-worker',
        name: 'lead-1',
      });
      const data = JSON.parse(result.content[0]!.text);

      expect(result.isError).toBe(true);
      expect(data.error).toContain('Use --room');
    });
  });

  describe('refresh', () => {
    test('refreshes agent pane', async () => {
      await handleJoinRoom({
        room: 'r',
        role: 'worker',
        name: 'w1',
        tmux_target: testPaneA,
      });
      const result = await handleRefresh({
        name: 'w1',
        tmux_target: testPaneB,
      });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.name).toBe('w1');
      expect(data.room).toBe('r');
      expect(data.tmux_target).toMatch(/^%\d+$/);
      expect(result.isError).toBeUndefined();

      await Bun.sleep(1200);
      const oldPaneOutput = await captureFromPane(testPaneA);
      expect(oldPaneOutput).toContain('pane ownership moved to');
      expect(oldPaneOutput).toContain('w1-stale-');
    });

    test('refresh keeps current room identity', async () => {
      await handleJoinRoom({
        room: 'r1',
        role: 'leader',
        name: 'lead',
        tmux_target: testPaneA,
      });
      const result = await handleRefresh({
        name: 'lead',
        tmux_target: testPaneB,
      });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.room).toBe('r1');
    });

    test('errors for unknown agent', async () => {
      const result = await handleRefresh({
        name: 'nobody',
        tmux_target: testPaneA,
      });
      expect(result.isError).toBe(true);
    });

    test('errors for invalid pane', async () => {
      await handleJoinRoom({
        room: 'r',
        role: 'worker',
        name: 'w1',
        tmux_target: testPaneA,
      });
      const result = await handleRefresh({ name: 'w1', tmux_target: '%99999' });
      expect(result.isError).toBe(true);
    });
  });

  describe('interrupt_worker', () => {
    test('leader can interrupt worker with current assignment', async () => {
      await handleJoinRoom({
        room: 'frontend',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'frontend',
        role: 'worker',
        name: 'builder-1',
        tmux_target: testPaneB,
      });

      await handleSendMessage({
        room: 'frontend',
        text: 'Build login',
        to: 'builder-1',
        name: 'lead-1',
        kind: 'task',
        mode: 'pull',
      });

      const result = await handleInterruptWorker({
        worker_name: 'builder-1',
        room: 'frontend',
        name: 'lead-1',
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]?.text);
      expect(data.interrupted).toBe(true);
    });

    test('worker cannot interrupt', async () => {
      await handleJoinRoom({
        room: 'frontend',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'frontend',
        role: 'worker',
        name: 'builder-1',
        tmux_target: testPaneB,
      });

      const result = await handleInterruptWorker({
        worker_name: 'lead-1',
        room: 'frontend',
        name: 'builder-1',
      });
      expect(result.isError).toBe(true);
    });

    test('can interrupt a worker even without persisted task state', async () => {
      await handleJoinRoom({
        room: 'frontend',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'frontend',
        role: 'worker',
        name: 'builder-1',
        tmux_target: testPaneB,
      });

      const result = await handleInterruptWorker({
        worker_name: 'builder-1',
        room: 'frontend',
        name: 'lead-1',
      });
      expect(result.isError).toBeUndefined();
    });
  });

  describe('clear_worker_session', () => {
    test('leader can clear worker session', async () => {
      await handleJoinRoom({
        room: 'test-room',
        role: 'leader',
        name: 'lead-01',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'test-room',
        role: 'worker',
        name: 'wk-01',
        tmux_target: testPaneB,
      });

      const result = await handleClearWorkerSession({
        worker_name: 'wk-01',
        room: 'test-room',
        name: 'lead-01',
      });
      const data = JSON.parse(result.content[0]?.text);
      if (result.isError) {
        expect(data.error).toMatch(/no longer exists|pane/i);
        return;
      }
      expect(data.cleared).toBe(true);
      expect(data.worker_name).toBe('wk-01');
    }, 15000);

    test('worker cannot clear sessions', async () => {
      await handleJoinRoom({
        room: 'test-room',
        role: 'leader',
        name: 'lead-01',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'test-room',
        role: 'worker',
        name: 'wk-01',
        tmux_target: testPaneB,
      });

      const result = await handleClearWorkerSession({
        worker_name: 'lead-01',
        room: 'test-room',
        name: 'wk-01',
      });
      expect(result.isError).toBe(true);
    });

    test('errors when worker not found', async () => {
      await handleJoinRoom({
        room: 'test-room',
        role: 'leader',
        name: 'lead-01',
        tmux_target: testPaneA,
      });

      const result = await handleClearWorkerSession({
        worker_name: 'nonexistent',
        room: 'test-room',
        name: 'lead-01',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('polling control', () => {
    test('pause and resume polling updates shared state', () => {
      const paused = handlePausePolling({ reason: 'manual chat' });
      expect(paused.isError).toBeUndefined();
      const pausedData = JSON.parse(paused.content[0]!.text);
      expect(pausedData.paused).toBe(true);
      expect(pausedData.reason).toBe('manual chat');

      const status = handlePollingStatus();
      const statusData = JSON.parse(status.content[0]!.text);
      expect(statusData.paused).toBe(true);
      expect(statusData.reason).toBe('manual chat');

      const resumed = handleResumePolling();
      const resumedData = JSON.parse(resumed.content[0]!.text);
      expect(resumedData.paused).toBe(false);
      expect(resumedData.reason).toBeNull();

      const finalState = getSweepControlState();
      expect(finalState.delivery_paused).toBe(false);
      expect(finalState.pause_reason).toBeNull();
    });

    test('set polling busy mode validates input', () => {
      const bad = handleSetPollingBusy({ mode: 'wrong' });
      expect(bad.isError).toBe(true);

      const good = handleSetPollingBusy({ mode: 'manual_busy' });
      expect(good.isError).toBeUndefined();
      const data = JSON.parse(good.content[0]!.text);
      expect(data.busy_mode).toBe('manual_busy');

      const state = getSweepControlState();
      expect(state.busy_mode).toBe('manual_busy');
    });

    test('direct state api keeps defaults and supports mode switch', () => {
      const initial = getSweepControlState();
      expect(initial.busy_mode).toBe('auto');

      setSweepPaused(true, 'temp');
      setSweepBusyMode('manual_free');

      const next = getSweepControlState();
      expect(next.delivery_paused).toBe(true);
      expect(next.pause_reason).toBe('temp');
      expect(next.busy_mode).toBe('manual_free');
    });
  });

  describe('reassign_task', () => {
    test('leader can replace a current assignment', async () => {
      await handleJoinRoom({
        room: 'frontend',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'frontend',
        role: 'worker',
        name: 'builder-1',
        tmux_target: testPaneB,
      });

      await handleSendMessage({
        room: 'frontend',
        text: 'Build login',
        to: 'builder-1',
        name: 'lead-1',
        kind: 'task',
      });

      const result = await handleReassignTask({
        worker_name: 'builder-1',
        room: 'frontend',
        text: 'Build signup instead',
        name: 'lead-1',
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]?.text);
      expect(data.reassigned).toBe(true);
    }, 15000);

    test('leader can replace an assignment without task ids', async () => {
      await handleJoinRoom({
        room: 'frontend',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'frontend',
        role: 'worker',
        name: 'builder-1',
        tmux_target: testPaneB,
      });

      const result = await handleReassignTask({
        worker_name: 'builder-1',
        room: 'frontend',
        text: 'Build signup instead',
        name: 'lead-1',
      });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.reassigned).toBe(true);
    }, 15000);

    test('leader can reassign to idle worker', async () => {
      await handleJoinRoom({
        room: 'frontend',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'frontend',
        role: 'worker',
        name: 'builder-1',
        tmux_target: testPaneB,
      });

      const result = await handleReassignTask({
        worker_name: 'builder-1',
        room: 'frontend',
        text: 'Build login',
        name: 'lead-1',
      });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.reassigned).toBe(true);
    });

    test('worker cannot reassign', async () => {
      await handleJoinRoom({
        room: 'frontend',
        role: 'leader',
        name: 'lead-1',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'frontend',
        role: 'worker',
        name: 'builder-1',
        tmux_target: testPaneB,
      });

      const result = await handleReassignTask({
        worker_name: 'lead-1',
        room: 'frontend',
        text: 'Do something',
        name: 'builder-1',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('manage', () => {
    test('returns error if caller name is missing', async () => {
      const { handleManage } = await import('../src/tools/manage.ts');
      const result = await handleManage({ name: '' });
      expect(result.isError).toBe(true);
    });

    test('exits early if no rooms are found', async () => {
      const { handleManage } = await import('../src/tools/manage.ts');
      const { Readable, Writable } = await import('node:stream');

      class MockStdin extends Readable {
        isTTY = true;
        _read() {}
      }
      class MockStdout extends Writable {
        isTTY = true;
        output: string[] = [];
        _write(chunk: any, encoding: any, callback: any) {
          this.output.push(chunk.toString());
          callback();
        }
      }

      const stdin = new MockStdin();
      const stdout = new MockStdout();

      const result = await handleManage({ name: 'leader-1', stdin, stdout });
      expect(result.isError).toBeUndefined();
      expect(stdout.output.join('')).toContain(
        'You are not a member of any active rooms',
      );
    });

    test('manages a room and sets topic', async () => {
      const room = getOrCreateRoom('/test/manage-room', 'manage-room');
      const { handleManage } = await import('../src/tools/manage.ts');
      const { Readable, Writable } = await import('node:stream');

      class MockStdin extends Readable {
        isTTY = true;
        rawModeEnabled = false;
        _read() {}
        setRawMode(mode: boolean) {
          this.rawModeEnabled = mode;
          return this;
        }
        sendKey(key: { name: string; ctrl?: boolean }) {
          this.emit('keypress', null, key);
        }
      }

      class MockStdout extends Writable {
        isTTY = true;
        output: string[] = [];
        _write(chunk: any, encoding: any, callback: any) {
          this.output.push(chunk.toString());
          callback();
        }
      }

      const stdin = new MockStdin();
      const stdout = new MockStdout();

      const { addAgent } = await import('../src/state/index.ts');
      addAgent('leader-1', 'leader', room.id, testPaneA);

      const promise = handleManage({ name: 'leader-1', stdin, stdout });

      // Room selection menu
      await Bun.sleep(100);
      stdin.sendKey({ name: 'return' });

      // Room actions menu
      // 0: Manage members (Single)
      // 1: Manage members (Bulk)
      // 2: Set room topic
      await Bun.sleep(100);
      stdin.sendKey({ name: 'down' });
      await Bun.sleep(100);
      stdin.sendKey({ name: 'down' });
      await Bun.sleep(100);
      stdin.sendKey({ name: 'return' });

      // Prompt for topic
      await Bun.sleep(100);
      stdin.push('New cool topic\n');

      // Escape back to room selection
      await Bun.sleep(100);
      stdin.sendKey({ name: 'escape' });

      // Escape back to exit
      await Bun.sleep(100);
      stdin.sendKey({ name: 'escape' });

      await promise;

      expect(stdout.output.join('')).toContain('Successfully updated topic');
      const updatedRoom = getRoom('manage-room');
      expect(updatedRoom?.topic).toBe('New cool topic');
    });

    test('manages a member and interrupts worker', async () => {
      const room = getOrCreateRoom('/test/manage-room-2', 'manage-room-2');
      const { handleManage } = await import('../src/tools/manage.ts');
      const { Readable, Writable } = await import('node:stream');

      class MockStdin extends Readable {
        isTTY = true;
        rawModeEnabled = false;
        _read() {}
        setRawMode(mode: boolean) {
          this.rawModeEnabled = mode;
          return this;
        }
        sendKey(key: { name: string; ctrl?: boolean }) {
          this.emit('keypress', null, key);
        }
      }

      class MockStdout extends Writable {
        isTTY = true;
        output: string[] = [];
        _write(chunk: any, encoding: any, callback: any) {
          this.output.push(chunk.toString());
          callback();
        }
      }

      const stdin = new MockStdin();
      const stdout = new MockStdout();

      const { addAgent } = await import('../src/state/index.ts');
      addAgent('leader-2', 'leader', room.id, testPaneA);
      addAgent('worker-2', 'worker', room.id, testPaneB);

      const promise = handleManage({ name: 'leader-2', stdin, stdout });

      // Select room
      await Bun.sleep(100);
      stdin.sendKey({ name: 'return' });

      // Select "Manage members (Single)" (index 0)
      await Bun.sleep(100);
      stdin.sendKey({ name: 'return' });

      // Select worker-2 (now at index 0 because leader-2 is filtered out)
      await Bun.sleep(100);
      stdin.sendKey({ name: 'return' });

      // Select "Interrupt Worker" (index 0)
      await Bun.sleep(100);
      stdin.sendKey({ name: 'return' });

      // Wait for handleInterruptWorker to complete and the next menu to render
      await Bun.sleep(2000);

      // Escape from member actions
      stdin.sendKey({ name: 'escape' });
      await Bun.sleep(100);
      // Escape from member selection
      stdin.sendKey({ name: 'escape' });
      await Bun.sleep(100);
      // Escape from room menu
      stdin.sendKey({ name: 'escape' });
      await Bun.sleep(100);
      // Escape from room list
      stdin.sendKey({ name: 'escape' });

      await promise;

      expect(stdout.output.join('')).toContain(
        'Successfully interrupted worker worker-2',
      );
    });
  });
});
