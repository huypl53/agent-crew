import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import type { TaskStatus, Task } from '../src/shared/types.ts';
import { initDb, closeDb } from '../src/state/db.ts';
import { handleJoinRoom } from '../src/tools/join-room.ts';
import { handleLeaveRoom } from '../src/tools/leave-room.ts';
import { handleListRooms } from '../src/tools/list-rooms.ts';
import { handleListMembers } from '../src/tools/list-members.ts';
import { handleReadMessages } from '../src/tools/read-messages.ts';
import { handleSendMessage } from '../src/tools/send-message.ts';
import { clearState, createTask, updateTaskStatus } from '../src/state/index.ts';
import { handleSetRoomTopic } from '../src/tools/set-room-topic.ts';
import { handleRefresh } from '../src/tools/refresh.ts';
import { handleGetStatus } from '../src/tools/get-status.ts';
import { handleUpdateTask } from '../src/tools/update-task.ts';
import { handleInterruptWorker } from '../src/tools/interrupt-worker.ts';
import { handleReassignTask } from '../src/tools/reassign-task.ts';
import { createTestSession, destroyTestSession, cleanupAllTestSessions, captureFromPane } from './helpers.ts';

let testPaneA: string;
let testPaneB: string;
const SESSION_A = 'tools-a';
const SESSION_B = 'tools-b';

describe('MCP tools', () => {
  beforeEach(async () => {
    initDb(':memory:');
    const a = await createTestSession(SESSION_A);
    const b = await createTestSession(SESSION_B);
    testPaneA = a.pane;
    testPaneB = b.pane;
  });

  afterAll(async () => {
    await cleanupAllTestSessions();
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
      const data = JSON.parse(result.content[0]!.text);
      expect(data.name).toBe('boss-1');
      expect(data.role).toBe('boss');
      expect(data.room).toBe('company');
    });

    test('rejects duplicate name in same room', async () => {
      await handleJoinRoom({ room: 'company', role: 'boss', name: 'boss-1', tmux_target: testPaneA });
      const result = await handleJoinRoom({ room: 'company', role: 'worker', name: 'boss-1', tmux_target: testPaneB });
      expect(result.isError).toBe(true);
    });

    test('allows same agent in multiple rooms', async () => {
      await handleJoinRoom({ room: 'company', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      const result = await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      expect(result.isError).toBeUndefined();
    });

    test('rejects invalid role', async () => {
      const result = await handleJoinRoom({ room: 'r', role: 'admin', name: 'n', tmux_target: testPaneA });
      expect(result.isError).toBe(true);
    });

    test('rejects non-existent pane', async () => {
      const result = await handleJoinRoom({ room: 'r', role: 'worker', name: 'n', tmux_target: '%99999' });
      expect(result.isError).toBe(true);
    });
  });

  describe('leave_room', () => {
    test('removes agent from room', async () => {
      await handleJoinRoom({ room: 'company', role: 'boss', name: 'boss-1', tmux_target: testPaneA });
      const result = await handleLeaveRoom({ room: 'company', name: 'boss-1' });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.success).toBe(true);
    });

    test('errors when not in room', async () => {
      await handleJoinRoom({ room: 'company', role: 'boss', name: 'boss-1', tmux_target: testPaneA });
      const result = await handleLeaveRoom({ room: 'frontend', name: 'boss-1' });
      expect(result.isError).toBe(true);
    });
  });

  describe('list_rooms', () => {
    test('lists all rooms with counts', async () => {
      await handleJoinRoom({ room: 'company', role: 'boss', name: 'boss-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'company', role: 'leader', name: 'lead-1', tmux_target: testPaneB });
      const result = await handleListRooms();
      const data = JSON.parse(result.content[0]!.text);
      expect(data.rooms.length).toBe(1);
      expect(data.rooms[0].name).toBe('company');
      expect(data.rooms[0].member_count).toBe(2);
      expect(data.rooms[0].roles.boss).toBe(1);
      expect(data.rooms[0].roles.leader).toBe(1);
    });
  });

  describe('list_members', () => {
    test('lists members of a room', async () => {
      await handleJoinRoom({ room: 'company', role: 'boss', name: 'boss-1', tmux_target: testPaneA });
      const result = await handleListMembers({ room: 'company' });
      const data = JSON.parse(result.content[0]!.text);
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
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

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
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const result = await handleSendMessage({
        room: 'frontend',
        text: 'Task complete',
        to: 'lead-1',
        name: 'builder-1',
        mode: 'pull',
      });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.queued).toBe(true);
      expect(data.delivered).toBe(false);
    });

    test('broadcast message reaches all members except sender', async () => {
      await handleJoinRoom({ room: 'team', role: 'leader', name: 'lead', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'team', role: 'worker', name: 'w1', tmux_target: testPaneB });

      await handleSendMessage({ room: 'team', text: 'Stand by', name: 'lead' });

      const readW1 = await handleReadMessages({ name: 'w1' });
      const w1Data = JSON.parse(readW1.content[0]!.text);
      expect(w1Data.messages.length).toBe(1);

      // Sender should NOT receive their own broadcast
      const readLead = await handleReadMessages({ name: 'lead' });
      const leadData = JSON.parse(readLead.content[0]!.text);
      expect(leadData.messages.length).toBe(0);
    });

    test('cursor-based read_messages', async () => {
      await handleJoinRoom({ room: 'r', role: 'worker', name: 'a', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'r', role: 'leader', name: 'b', tmux_target: testPaneB });

      await handleSendMessage({ room: 'r', text: 'msg1', to: 'a', name: 'b' });
      await handleSendMessage({ room: 'r', text: 'msg2', to: 'a', name: 'b' });

      const first = await handleReadMessages({ name: 'a' });
      const firstData = JSON.parse(first.content[0]!.text);
      expect(firstData.messages.length).toBe(2);

      await handleSendMessage({ room: 'r', text: 'msg3', to: 'a', name: 'b' });

      const second = await handleReadMessages({ name: 'a', since_sequence: firstData.next_sequence });
      const secondData = JSON.parse(second.content[0]!.text);
      expect(secondData.messages.length).toBe(1);
      expect(secondData.messages[0].text).toBe('msg3');
    });

    test('room-filtered read_messages', async () => {
      await handleJoinRoom({ room: 'r1', role: 'worker', name: 'a', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'r1', role: 'leader', name: 'b', tmux_target: testPaneB });
      await handleJoinRoom({ room: 'r2', role: 'worker', name: 'a', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'r2', role: 'leader', name: 'b', tmux_target: testPaneB });

      await handleSendMessage({ room: 'r1', text: 'hello r1', to: 'a', name: 'b' });
      await handleSendMessage({ room: 'r2', text: 'hello r2', to: 'a', name: 'b' });

      const result = await handleReadMessages({ name: 'a', room: 'r1' });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.messages.length).toBe(1);
      expect(data.messages[0].room).toBe('r1');
    });

    test('read_messages with room reads room log (not just inbox)', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'w1', tmux_target: testPaneB });

      // leader sends directed message to w1
      await handleSendMessage({ room: 'frontend', text: 'build login', to: 'w1', name: 'lead-1' });

      // lead-1 can also read the room log (even though msg was TO w1)
      const result = await handleReadMessages({ name: 'lead-1', room: 'frontend' });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.messages.length).toBe(1);
      expect(data.messages[0].text).toBe('build login');
    });

    test('read_messages with kinds filter', async () => {
      await handleJoinRoom({ room: 'r', role: 'leader', name: 'lead', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'r', role: 'worker', name: 'w1', tmux_target: testPaneB });

      await handleSendMessage({ room: 'r', text: 'build it', to: 'w1', name: 'lead', kind: 'task' });
      await handleSendMessage({ room: 'r', text: 'done!', to: 'lead', name: 'w1', kind: 'completion', mode: 'pull' });

      const result = await handleReadMessages({ name: 'lead', room: 'r', kinds: ['completion'] });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.messages.length).toBe(1);
      expect(data.messages[0].kind).toBe('completion');
    });

    test('worker completion auto-notifies leader via push', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'w1', tmux_target: testPaneB });

      // worker sends pull completion to leader
      await handleSendMessage({
        room: 'frontend', text: 'Login component done', to: 'lead-1',
        name: 'w1', mode: 'pull', kind: 'completion',
      });

      // Verify push was sent to leader's pane
      await Bun.sleep(200);
      const captured = await captureFromPane(testPaneA);
      expect(captured).toContain('[system@frontend]');
      expect(captured).toContain('w1');
      expect(captured).toContain('Login component done');
    });

    test('send_message with kind=task creates task record and returns task_id', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const result = await handleSendMessage({
        room: 'frontend',
        text: 'Build the login page with validation',
        to: 'builder-1',
        name: 'lead-1',
        kind: 'task',
      });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.task_id).toBeDefined();
      expect(data.task_id).toBeGreaterThan(0);
    });

    test('send_message with kind=task requires to param', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const result = await handleSendMessage({
        room: 'frontend',
        text: 'Build something',
        name: 'lead-1',
        kind: 'task',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('update_task', () => {
    test('worker can update own task', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      // Create a task via send_message
      const sendResult = await handleSendMessage({
        room: 'frontend', text: 'Build login', to: 'builder-1', name: 'lead-1', kind: 'task',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;

      const result = await handleUpdateTask({ task_id: taskId, status: 'active', name: 'builder-1' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]!.text);
      expect(data.updated).toBe(true);
      expect(data.status).toBe('active');
    });

    test('worker cannot update another workers task', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-2', tmux_target: testPaneA });

      const sendResult = await handleSendMessage({
        room: 'frontend', text: 'Build login', to: 'builder-1', name: 'lead-1', kind: 'task',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;

      const result = await handleUpdateTask({ task_id: taskId, status: 'active', name: 'builder-2' });
      expect(result.isError).toBe(true);
    });

    test('non-worker is rejected', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const sendResult = await handleSendMessage({
        room: 'frontend', text: 'Build login', to: 'builder-1', name: 'lead-1', kind: 'task',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;

      const result = await handleUpdateTask({ task_id: taskId, status: 'active', name: 'lead-1' });
      expect(result.isError).toBe(true);
    });
  });

  describe('set_room_topic', () => {
    test('sets and retrieves room topic', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      const result = await handleSetRoomTopic({ room: 'frontend', text: 'Build auth system', name: 'lead-1' });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.topic).toBe('Build auth system');

      // Verify it shows in list_members
      const members = await handleListMembers({ room: 'frontend' });
      const membersData = JSON.parse(members.content[0]!.text);
      expect(membersData.topic).toBe('Build auth system');
    });

    test('rejects non-member setting topic', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      const result = await handleSetRoomTopic({ room: 'frontend', text: 'Hack', name: 'outsider' });
      expect(result.isError).toBe(true);
    });
  });

  describe('refresh', () => {
    test('refreshes agent pane', async () => {
      await handleJoinRoom({ room: 'r', role: 'worker', name: 'w1', tmux_target: testPaneA });
      const result = await handleRefresh({ name: 'w1', tmux_target: testPaneB });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.name).toBe('w1');
      expect(data.rooms).toContain('r');
      expect(data.tmux_target).toBe(testPaneB);
      expect(result.isError).toBeUndefined();
    });

    test('preserves rooms after refresh', async () => {
      await handleJoinRoom({ room: 'r1', role: 'leader', name: 'lead', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'r2', role: 'leader', name: 'lead', tmux_target: testPaneA });
      const result = await handleRefresh({ name: 'lead', tmux_target: testPaneB });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.rooms).toEqual(['r1', 'r2']);
    });

    test('errors for unknown agent', async () => {
      const result = await handleRefresh({ name: 'nobody', tmux_target: testPaneA });
      expect(result.isError).toBe(true);
    });

    test('errors for invalid pane', async () => {
      await handleJoinRoom({ room: 'r', role: 'worker', name: 'w1', tmux_target: testPaneA });
      const result = await handleRefresh({ name: 'w1', tmux_target: '%99999' });
      expect(result.isError).toBe(true);
    });
  });

  describe('interrupt_worker', () => {
    test('leader can interrupt worker with active task', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      // Create and activate a task
      const sendResult = await handleSendMessage({
        room: 'frontend', text: 'Build login', to: 'builder-1', name: 'lead-1', kind: 'task',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;
      await handleUpdateTask({ task_id: taskId, status: 'active', name: 'builder-1' });

      const result = await handleInterruptWorker({ worker_name: 'builder-1', room: 'frontend', name: 'lead-1' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]!.text);
      expect(data.interrupted).toBe(true);
      expect(data.task_id).toBe(taskId);
    });

    test('worker cannot interrupt', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const result = await handleInterruptWorker({ worker_name: 'lead-1', room: 'frontend', name: 'builder-1' });
      expect(result.isError).toBe(true);
    });

    test('errors when no active task', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const result = await handleInterruptWorker({ worker_name: 'builder-1', room: 'frontend', name: 'lead-1' });
      expect(result.isError).toBe(true);
    });
  });

  describe('reassign_task', () => {
    test('leader can reassign active task', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const sendResult = await handleSendMessage({
        room: 'frontend', text: 'Build login', to: 'builder-1', name: 'lead-1', kind: 'task',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;
      await handleUpdateTask({ task_id: taskId, status: 'active', name: 'builder-1' });

      const result = await handleReassignTask({
        worker_name: 'builder-1', room: 'frontend', text: 'Build signup instead', name: 'lead-1',
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]!.text);
      expect(data.reassigned).toBe(true);
      expect(data.old_task_id).toBe(taskId);
      expect(data.new_task_id).toBeDefined();
    });

    test('leader can reassign queued task', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const sendResult = await handleSendMessage({
        room: 'frontend', text: 'Build login', to: 'builder-1', name: 'lead-1', kind: 'task',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;
      await handleUpdateTask({ task_id: taskId, status: 'queued', name: 'builder-1' });

      const result = await handleReassignTask({
        worker_name: 'builder-1', room: 'frontend', text: 'Build signup instead', name: 'lead-1',
      });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.reassigned).toBe(true);
      expect(data.old_task_id).toBe(taskId);
    });

    test('leader can reassign to idle worker', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const result = await handleReassignTask({
        worker_name: 'builder-1', room: 'frontend', text: 'Build login', name: 'lead-1',
      });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.reassigned).toBe(true);
      expect(data.old_task_id).toBeUndefined();
      expect(data.new_task_id).toBeDefined();
    });

    test('worker cannot reassign', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const result = await handleReassignTask({
        worker_name: 'lead-1', room: 'frontend', text: 'Do something', name: 'builder-1',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('get_status with tasks', () => {
    test('includes current and queued tasks in response', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      // Create two tasks using state functions directly
      const t1 = createTask('frontend', 'builder-1', 'lead-1', null, 'Task A');
      const t2 = createTask('frontend', 'builder-1', 'lead-1', null, 'Task B');
      updateTaskStatus(t1.id, 'active');
      updateTaskStatus(t2.id, 'queued');

      const result = await handleGetStatus({ agent_name: 'builder-1' });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.current_task).toBeDefined();
      expect(data.current_task.id).toBe(t1.id);
      expect(data.current_task.status).toBe('active');
      expect(data.queued_tasks).toBeDefined();
      expect(data.queued_tasks.length).toBe(1);
      expect(data.queued_tasks[0].id).toBe(t2.id);
    });
  });
});
