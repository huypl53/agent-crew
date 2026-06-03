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
import { clearState } from '../src/state/index.ts';
import { handleCheckChanges } from '../src/tools/check-changes.ts';
import { handleGetStatus } from '../src/tools/get-status.ts';
import { handleInterruptWorker } from '../src/tools/interrupt-worker.ts';
import { handleJoinRoom } from '../src/tools/join-room.ts';
import { handleReassignTask } from '../src/tools/reassign-task.ts';
import { handleSendMessage } from '../src/tools/send-message.ts';
import {
  captureFromPane,
  cleanupAllTestSessions,
  createTestSession,
  getCallerTestTag,
} from './helpers.ts';

config.senderVerification = 'off';

let leadPane: string;
let workerPane: string;
let seq = 0;

describe('task runtime removal', () => {
  beforeEach(async () => {
    initDb(':memory:');
    clearState();
    seq += 1;
    const leader = await createTestSession(`task-removal-lead-${seq}`);
    const worker = await createTestSession(`task-removal-worker-${seq}`);
    leadPane = leader.pane;
    workerPane = worker.pane;

    await handleJoinRoom({
      room: 'crew',
      role: 'leader',
      name: 'lead-1',
      tmux_target: leadPane,
    });
    await handleJoinRoom({
      room: 'crew',
      role: 'worker',
      name: 'wk-1',
      tmux_target: workerPane,
    });
  });

  afterEach(() => {
    delete process.env.TMUX_PANE;
    closeDb();
  });

  afterAll(async () => {
    await cleanupAllTestSessions(getCallerTestTag());
  });

  test('send_message with kind=task no longer returns task_id', async () => {
    const result = await handleSendMessage({
      room: 'crew',
      text: 'Implement auth flow',
      to: 'wk-1',
      mode: 'pull',
      name: 'lead-1',
      kind: 'task',
    });

    const data = JSON.parse(result.content[0]!.text);
    expect(result.isError).toBeUndefined();
    expect(data.message_id).toBeDefined();
    expect(data.task_id).toBeUndefined();
  });

  test('check_changes no longer exposes tasks scope', async () => {
    const result = await handleCheckChanges({ name: 'lead-1' });
    const data = JSON.parse(result.content[0]!.text);

    expect(Object.keys(data.scopes).sort()).toEqual(['agents', 'messages']);
    expect(data.scopes.tasks).toBeUndefined();
  });

  test('get_status no longer returns current or queued task state', async () => {
    const result = await handleGetStatus({ agent_name: 'wk-1' });
    const data = JSON.parse(result.content[0]!.text);

    expect(result.isError).toBeUndefined();
    expect(data.name).toBe('wk-1');
    expect(data.current_task).toBeUndefined();
    expect(data.queued_tasks).toBeUndefined();
  });

  test('interrupt_worker no longer requires an active persisted task', async () => {
    const result = await handleInterruptWorker({
      worker_name: 'wk-1',
      room: 'crew',
      name: 'lead-1',
    });
    const data = JSON.parse(result.content[0]!.text);

    expect(result.isError).toBeUndefined();
    expect(data.interrupted).toBe(true);
    expect(data.task_id).toBeUndefined();

    const paneText = await captureFromPane(workerPane);
    expect(paneText).toContain(
      'Your current assignment was interrupted by lead-1',
    );
  });

  test('reassign_task interrupts and sends a new assignment without task ids', async () => {
    const result = await handleReassignTask({
      worker_name: 'wk-1',
      room: 'crew',
      text: 'New assignment body',
      name: 'lead-1',
    });
    const data = JSON.parse(result.content[0]!.text);

    expect(result.isError).toBeUndefined();
    expect(data.reassigned).toBe(true);
    expect(data.old_task_id).toBeUndefined();
    expect(data.new_task_id).toBeUndefined();

    const paneText = await captureFromPane(workerPane);
    expect(paneText).toContain('New assignment body');
  });
});
