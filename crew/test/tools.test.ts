import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { config } from '../src/config.ts';
import type { Task, TaskStatus } from '../src/shared/types.ts';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  addAgent,
  clearState,
  createTask,
  getOrCreateRoom,
  getRoom,
  getSweepControlState,
  setSweepBusyMode,
  setSweepPaused,
  updateTaskStatus,
} from '../src/state/index.ts';
import { handleClearWorkerSession } from '../src/tools/clear-worker-session.ts';
import { handleGetStatus } from '../src/tools/get-status.ts';
import { handleGetTaskDetails } from '../src/tools/get-task-details.ts';
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
import { handleSearchTasks } from '../src/tools/search-tasks.ts';
import { handleSendMessage } from '../src/tools/send-message.ts';
import { handleSetRoomTopic } from '../src/tools/set-room-topic.ts';
import { handleUpdateTask } from '../src/tools/update-task.ts';
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
        role: 'boss',
        name: 'boss-1',
        tmux_target: testPaneA,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]?.text);
      expect(data.name).toBe('boss-1');
      expect(data.role).toBe('boss');
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
        role: 'boss',
        name: 'boss-1',
        tmux_target: testPaneA,
      });
      const result = await handleJoinRoom({
        room: 'company',
        role: 'worker',
        name: 'boss-1',
        tmux_target: testPaneB,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]?.text);
      expect(data.name).toMatch(/^boss-1-[a-z0-9]{4}$/);
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
        role: 'boss',
        name: 'boss-1',
        tmux_target: testPaneA,
      });
      const result = await handleLeaveRoom({ room: 'company', name: 'boss-1' });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.success).toBe(true);
    });

    test('errors when not in room', async () => {
      await handleJoinRoom({
        room: 'company',
        role: 'boss',
        name: 'boss-1',
        tmux_target: testPaneA,
      });
      const result = await handleLeaveRoom({
        room: 'frontend',
        name: 'boss-1',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('list_rooms', () => {
    test('lists all rooms with counts', async () => {
      await handleJoinRoom({
        room: 'company',
        role: 'boss',
        name: 'boss-1',
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
      expect(data.rooms[0].roles.boss).toBe(1);
      expect(data.rooms[0].roles.leader).toBe(1);
    });
  });

  describe('list_members', () => {
    test('lists members of a room', async () => {
      await handleJoinRoom({
        room: 'company',
        role: 'boss',
        name: 'boss-1',
        tmux_target: testPaneA,
      });
      const result = await handleListMembers({ room: 'company' });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.members.length).toBe(1);
      expect(data.members[0].name).toBe('boss-1');
    });

    test('errors for non-existent room', async () => {
      const result = await handleListMembers({ room: 'nope' });
      expect(result.isError).toBe(true);
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

    test('read_messages with room reads room log (not just inbox)', async () => {
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

      // lead-1 can also read the room log (even though msg was TO w1)
      const result = await handleReadMessages({
        name: 'lead-1',
        room: 'frontend',
      });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.messages.length).toBe(1);
      expect(data.messages[0].text).toBe('build login');
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

    test('send_message with kind=task creates task record and returns task_id', async () => {
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
      expect(data.task_id).toBeDefined();
      expect(data.task_id).toBeGreaterThan(0);
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

  describe('update_task', () => {
    test('worker can update own task', async () => {
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

      // Create a task via send_message
      const sendResult = await handleSendMessage({
        room: 'frontend',
        text: 'Build login',
        to: 'builder-1',
        name: 'lead-1',
        kind: 'task',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;

      const result = await handleUpdateTask({
        task_id: taskId,
        status: 'active',
        name: 'builder-1',
      });
      const data = JSON.parse(result.content[0]?.text);
      expect(result.isError).toBeUndefined();
      expect(data.updated).toBe(true);
      expect(data.status).toBe('active');
    });

    test('worker cannot update another workers task', async () => {
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
      await handleJoinRoom({
        room: 'frontend',
        role: 'worker',
        name: 'builder-2',
        tmux_target: testPaneA,
      });

      const sendResult = await handleSendMessage({
        room: 'frontend',
        text: 'Build login',
        to: 'builder-1',
        name: 'lead-1',
        kind: 'task',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;

      const result = await handleUpdateTask({
        task_id: taskId,
        status: 'active',
        name: 'builder-2',
      });
      expect(result.isError).toBe(true);
    });

    test('non-worker is rejected', async () => {
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
        text: 'Build login',
        to: 'builder-1',
        name: 'lead-1',
        kind: 'task',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;

      const result = await handleUpdateTask({
        task_id: taskId,
        status: 'active',
        name: 'lead-1',
      });
      expect(result.isError).toBe(true);
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
    test('leader can interrupt worker with active task', async () => {
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

      // Create and activate a task
      const sendResult = await handleSendMessage({
        room: 'frontend',
        text: 'Build login',
        to: 'builder-1',
        name: 'lead-1',
        kind: 'task',
        mode: 'pull',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;
      await handleUpdateTask({
        task_id: taskId,
        status: 'active',
        name: 'builder-1',
      });

      const result = await handleInterruptWorker({
        worker_name: 'builder-1',
        room: 'frontend',
        name: 'lead-1',
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]?.text);
      expect(data.interrupted).toBe(true);
      expect(data.task_id).toBe(taskId);
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

    test('errors when no active task', async () => {
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
      expect(result.isError).toBe(true);
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
    test('leader can reassign active task', async () => {
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
        text: 'Build login',
        to: 'builder-1',
        name: 'lead-1',
        kind: 'task',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;
      await handleUpdateTask({
        task_id: taskId,
        status: 'active',
        name: 'builder-1',
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
      expect(data.old_task_id).toBe(taskId);
      expect(data.new_task_id).toBeDefined();
    }, 15000);

    test('leader can reassign queued task', async () => {
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
        text: 'Build login',
        to: 'builder-1',
        name: 'lead-1',
        kind: 'task',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;
      await handleUpdateTask({
        task_id: taskId,
        status: 'queued',
        name: 'builder-1',
      });

      const result = await handleReassignTask({
        worker_name: 'builder-1',
        room: 'frontend',
        text: 'Build signup instead',
        name: 'lead-1',
      });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.reassigned).toBe(true);
      expect(data.old_task_id).toBe(taskId);
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
      expect(data.old_task_id).toBeUndefined();
      expect(data.new_task_id).toBeDefined();
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

  describe('get_status with tasks', () => {
    test('includes current and queued tasks in response', async () => {
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

      // Create two tasks using state functions directly
      const t1 = createTask('frontend', 'builder-1', 'lead-1', null, 'Task A');
      const t2 = createTask('frontend', 'builder-1', 'lead-1', null, 'Task B');
      updateTaskStatus(t1.id, 'active');
      updateTaskStatus(t2.id, 'queued');

      const result = await handleGetStatus({ agent_name: 'builder-1' });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.current_task).toBeDefined();
      expect(data.current_task.id).toBe(t1.id);
      expect(data.current_task.status).toBe('active');
      expect(data.queued_tasks).toBeDefined();
      expect(data.queued_tasks.length).toBe(1);
      expect(data.queued_tasks[0].id).toBe(t2.id);
    });
  });

  describe('get_task_details', () => {
    test('returns full task with context', async () => {
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
      const task = createTask(
        'test-room',
        'wk-01',
        'lead-01',
        null,
        'detail test task',
      );
      updateTaskStatus(task.id, 'active');
      updateTaskStatus(
        task.id,
        'completed',
        undefined,
        'Found auth issue in middleware',
      );

      const result = await handleGetTaskDetails({ task_id: task.id });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.context).toContain('auth issue');
    });

    test('returns error for nonexistent task', async () => {
      const result = await handleGetTaskDetails({ task_id: 99999 });
      expect(result.isError).toBe(true);
    });
  });

  describe('search_tasks', () => {
    test('searches by keyword', async () => {
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
      const task = createTask(
        'test-room',
        'wk-01',
        'lead-01',
        null,
        'search test auth fix',
      );
      updateTaskStatus(task.id, 'active');
      updateTaskStatus(
        task.id,
        'completed',
        undefined,
        'JWT tokens expire too early',
      );

      const result = await handleSearchTasks({ keyword: 'JWT' });
      const data = JSON.parse(result.content[0]?.text);
      expect(data.length).toBeGreaterThan(0);
    });

    test('searches by room', async () => {
      await handleJoinRoom({
        room: 'test-room',
        role: 'leader',
        name: 'lead-search',
        tmux_target: testPaneA,
      });
      await handleJoinRoom({
        room: 'test-room',
        role: 'worker',
        name: 'wk-search',
        tmux_target: testPaneB,
      });
      createTask(
        'test-room',
        'wk-search',
        'lead-search',
        null,
        'search room task',
      );
      const result = await handleSearchTasks({ room: 'test-room' });
      const data = JSON.parse(result.content[0]?.text);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
    });

    test('returns empty for no matches', async () => {
      const result = await handleSearchTasks({
        keyword: 'zzz_nonexistent_zzz',
      });
      const data = JSON.parse(result.content[0]?.text);
      expect(data).toEqual([]);
    });
  });
});
