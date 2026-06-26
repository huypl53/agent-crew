import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { closeDb, initDb } from '../src/state/db.ts';
import { getAgent, getOrCreateRoom, getRoom } from '../src/state/index.ts';
import { handleDeleteRoom } from '../src/tools/delete-room.ts';
import { handleJoinRoom } from '../src/tools/join-room.ts';
import { handleRefresh } from '../src/tools/refresh.ts';
import {
  cleanupAllTestSessions,
  createTestSession,
  destroyTestSession,
} from './helpers.ts';

let testPane1 = '';
let testPane2 = '';

beforeAll(async () => {
  const session1 = await createTestSession('bypass-1');
  testPane1 = session1.pane;
  const session2 = await createTestSession('bypass-2');
  testPane2 = session2.pane;
});

afterAll(async () => {
  await destroyTestSession('bypass-1');
  await destroyTestSession('bypass-2');
  await cleanupAllTestSessions();
});

describe('room-id bypass and old-room refresh', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  test('joins a room using room_id and bypasses CWD mapping', async () => {
    const leadResult = await handleJoinRoom({
      room: 'project-xyz',
      role: 'leader',
      name: 'lead-1',
      tmux_target: testPane1,
    });
    expect(leadResult.isError).toBeUndefined();

    const room = getRoom('project-xyz');
    expect(room).toBeDefined();
    const createdRoomId = room!.id;

    const workerResult = await handleJoinRoom({
      role: 'worker',
      name: 'worker-1',
      tmux_target: testPane2,
      room_id: createdRoomId,
    });
    expect(workerResult.isError).toBeUndefined();
    const workerData = JSON.parse(workerResult.content[0]!.text);
    expect(workerData.room).toBe('project-xyz');

    const agent = getAgent('worker-1');
    expect(agent).toBeDefined();
    expect(agent!.room_id).toBe(createdRoomId);
  });

  test('refreshes agent to their old room instead of CWD room', async () => {
    const joinResult = await handleJoinRoom({
      room: 'project-xyz',
      role: 'worker',
      name: 'agent-1',
      tmux_target: testPane1,
    });
    expect(joinResult.isError).toBeUndefined();
    const room = getRoom('project-xyz');
    const roomId = room!.id;

    const refreshResult = await handleRefresh({
      name: 'agent-1',
      tmux_target: testPane2,
    });
    expect(refreshResult.isError).toBeUndefined();
    const refreshData = JSON.parse(refreshResult.content[0]!.text);
    expect(refreshData.room).toBe('project-xyz');
    expect(refreshData.tmux_target).toBe(testPane2);

    const updatedAgent = getAgent('agent-1');
    expect(updatedAgent).toBeDefined();
    expect(updatedAgent!.room_id).toBe(roomId);
    expect(updatedAgent!.tmux_target).toBe(testPane2);
  });

  test('deletes a room by room id', async () => {
    const joinResult = await handleJoinRoom({
      room: 'project-xyz',
      role: 'leader',
      name: 'lead-1',
      tmux_target: testPane1,
    });
    expect(joinResult.isError).toBeUndefined();
    const room = getRoom('project-xyz');
    expect(room).toBeDefined();
    const createdRoomId = room!.id;

    const deleteResult = await handleDeleteRoom({
      room: String(createdRoomId),
      confirm: true,
      name: 'lead-1',
    });
    expect(deleteResult.isError).toBeUndefined();
    const deleteData = JSON.parse(deleteResult.content[0]!.text);
    expect(deleteData.deleted).toBe(true);

    expect(getRoom(createdRoomId)).toBeUndefined();
  });
});
