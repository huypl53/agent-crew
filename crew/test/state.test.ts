import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  addAgent,
  addHookEvent,
  addMessage,
  advanceCursor,
  cancelQueuedTasksForAgent,
  cleanupDeadAgentTasks,
  canonicalizeHintIdentity,
  clearState,
  createTask,
  getAgent,
  getAllRooms,
  getAllTaskEvents,
  getChangeVersions,
  getCursor,
  getHint,
  getOrCreateRoom,
  getPricing,
  getRoom,
  getRoomMembers,
  getRoomMessages,
  getTask,
  getTaskDetails,
  getTaskEvents,
  getTasksForAgent,
  getTokenUsageForAgent,
  getTotalCost,
  isNameTakenInRoom,
  readMessages,
  readRoomMessages,
  recordTaskEvent,
  recordTokenUsage,
  removeAgent,
  removeAgentFully,
  searchTasks,
  setHint,
  tickHintCadence,
  unsetHint,
  updateTaskStatus,
  upsertPricing,
  validateLiveness,
} from '../src/state/index.ts';

function mkRoom(name: string) {
  return getOrCreateRoom(`/test/${name}`, name);
}

describe('state module', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  describe('agents', () => {
    test('adds and retrieves an agent', () => {
      const agent = addAgent('leader', 'leader', mkRoom('company').id, '%100');
      expect(agent.name).toBe('leader');
      expect(agent.role).toBe('leader');
      expect(agent.room_name).toBe('company');
      expect(getAgent('leader')).toBeDefined();
    });

    test('latest registration determines agent room', () => {
      addAgent('lead-1', 'leader', mkRoom('company').id, '%101');
      addAgent('lead-1', 'leader', mkRoom('frontend').id, '%101');
      const agent = getAgent('lead-1');
      expect(agent?.room_name).toBe('frontend');
    });

    test('removes agent from room', () => {
      addAgent('worker-1', 'worker', mkRoom('frontend').id, '%102');
      removeAgent('worker-1', 'frontend');
      expect(getAgent('worker-1')).toBeUndefined();
    });

    test('removing latest room removes latest registration', () => {
      addAgent('lead-1', 'leader', mkRoom('company').id, '%101');
      addAgent('lead-1', 'leader', mkRoom('frontend').id, '%101');
      removeAgent('lead-1', 'frontend');
      const agent = getAgent('lead-1');
      expect(agent?.room_name).toBe('company');
    });
  });

  describe('rooms', () => {
    test('creates room on first agent join', () => {
      addAgent('leader', 'leader', mkRoom('company').id, '%100');
      const room = getRoom('company');
      expect(room).toBeDefined();
      const members = getRoomMembers(room!.id);
      expect(members.map((m) => m.name)).toEqual(['leader']);
    });

    test('room tracks all members', () => {
      addAgent('leader', 'leader', mkRoom('company').id, '%100');
      addAgent('lead-1', 'leader', mkRoom('company').id, '%101');
      const room = getRoom('company');
      const members = getRoomMembers(room!.id);
      expect(members.map((m) => m.name)).toEqual(['leader', 'lead-1']);
    });

    test('room is deleted when last member leaves', () => {
      addAgent('worker-1', 'worker', mkRoom('temp').id, '%102');
      removeAgent('worker-1', 'temp');
      expect(getRoom('temp')).toBeUndefined();
    });

    test('getAllRooms returns all rooms', () => {
      addAgent('leader', 'leader', mkRoom('company').id, '%100');
      addAgent('worker-1', 'worker', mkRoom('frontend').id, '%102');
      expect(getAllRooms().length).toBe(2);
    });

    test('getRoomMembers returns agents', () => {
      addAgent('leader', 'leader', mkRoom('company').id, '%100');
      addAgent('lead-1', 'leader', mkRoom('company').id, '%101');
      const members = getRoomMembers(getRoom('company')!.id);
      expect(members.length).toBe(2);
      expect(members.map((m) => m.name)).toEqual(['leader', 'lead-1']);
    });

    test('isNameTakenInRoom detects duplicates', () => {
      addAgent('leader', 'leader', mkRoom('company').id, '%100');
      expect(isNameTakenInRoom('leader', 'company')).toBe(true);
      expect(isNameTakenInRoom('leader', 'frontend')).toBe(false);
      expect(isNameTakenInRoom('nobody', 'company')).toBe(false);
    });
  });

  describe('messages', () => {
    test('adds and reads messages', () => {
      addAgent('sender', 'leader', mkRoom('room').id, '%100');
      addAgent('receiver', 'worker', mkRoom('room').id, '%101');

      addMessage('receiver', 'sender', 'room', 'hello', 'push', 'receiver');
      addMessage('receiver', 'sender', 'room', 'world', 'push', 'receiver');

      const result = readMessages('receiver');
      expect(result.messages.length).toBe(2);
      expect(result.messages[0]!.text).toBe('hello');
      expect(result.messages[1]!.text).toBe('world');
    });

    test('cursor-based reading with since_sequence', () => {
      addAgent('a', 'worker', mkRoom('r').id, '%100');
      addMessage('a', 'b', 'r', 'msg1', 'push', 'a');
      addMessage('a', 'b', 'r', 'msg2', 'push', 'a');

      const first = readMessages('a');
      expect(first.messages.length).toBe(2);

      addMessage('a', 'b', 'r', 'msg3', 'push', 'a');
      const second = readMessages('a', undefined, first.next_sequence);
      expect(second.messages.length).toBe(1);
      expect(second.messages[0]!.text).toBe('msg3');
    });

    test('filters by room', () => {
      addAgent('a', 'worker', mkRoom('room1').id, '%100');
      addAgent('b', 'leader', mkRoom('room1').id, '%101');
      addMessage('a', 'b', 'room1', 'hello', 'push', 'a');

      const result = readMessages('a', 'room1');
      expect(result.messages.length).toBe(1);
      expect(result.messages[0]!.room_id).toBe(getRoom('room1')!.id);
    });

    test('message has kind field', () => {
      addAgent('a', 'worker', mkRoom('r').id, '%100');
      addAgent('b', 'leader', mkRoom('r').id, '%101');
      const msg = addMessage('a', 'b', 'r', 'hello', 'push', 'a', 'chat');
      expect(msg.kind).toBe('chat');
    });

    test('message kind defaults to chat', () => {
      addAgent('a', 'worker', mkRoom('r').id, '%100');
      addAgent('b', 'leader', mkRoom('r').id, '%101');
      const msg = addMessage('a', 'b', 'r', 'hello', 'push', 'a');
      expect(msg.kind).toBe('chat');
    });
  });

  describe('room messages', () => {
    test('message is stored in room log', () => {
      addAgent('a', 'leader', mkRoom('frontend').id, '%100');
      addAgent('b', 'worker', mkRoom('frontend').id, '%101');
      addMessage('b', 'a', 'frontend', 'build login', 'push', 'b', 'task');

      const roomMsgs = getRoomMessages('frontend');
      expect(roomMsgs.length).toBe(1);
      expect(roomMsgs[0]!.text).toBe('build login');
      expect(roomMsgs[0]!.from).toBe('a');
    });

    test('all room members can read room messages', () => {
      addAgent('lead', 'leader', mkRoom('frontend').id, '%100');
      addAgent('w1', 'worker', mkRoom('frontend').id, '%101');
      addAgent('w2', 'worker', mkRoom('frontend').id, '%102');

      addMessage('w1', 'lead', 'frontend', 'build login', 'push', 'w1', 'task');

      const roomMsgs = getRoomMessages('frontend');
      expect(roomMsgs.length).toBe(1);
    });

    test('broadcast is one canonical message', () => {
      addAgent('lead', 'leader', mkRoom('team').id, '%100');
      addAgent('w1', 'worker', mkRoom('team').id, '%101');
      addAgent('w2', 'worker', mkRoom('team').id, '%102');

      addMessage('__room__', 'lead', 'team', 'standup', 'push', null, 'chat');

      const roomMsgs = getRoomMessages('team');
      expect(roomMsgs.length).toBe(1);
      expect(roomMsgs[0]!.to).toBeNull();
    });
  });

  describe('cursors', () => {
    test('getCursor returns 0 for new agent-room pair', () => {
      addAgent('a', 'worker', mkRoom('r').id, '%100');
      expect(getCursor('a', 'r')).toBe(0);
    });

    test('advanceCursor updates read position', () => {
      addAgent('a', 'worker', mkRoom('r').id, '%100');
      advanceCursor('a', 'r', 5);
      expect(getCursor('a', 'r')).toBe(5);
    });

    test('readRoomMessages advances cursor', () => {
      addAgent('lead', 'leader', mkRoom('r').id, '%100');
      addAgent('w1', 'worker', mkRoom('r').id, '%101');

      addMessage('w1', 'lead', 'r', 'task1', 'push', 'w1', 'task');
      addMessage('w1', 'lead', 'r', 'task2', 'push', 'w1', 'task');

      // First read: gets both messages
      const first = readRoomMessages('w1', 'r');
      expect(first.messages.length).toBe(2);

      // Add a third message
      addMessage('w1', 'lead', 'r', 'task3', 'push', 'w1', 'task');

      // Second read: only new message
      const second = readRoomMessages('w1', 'r');
      expect(second.messages.length).toBe(1);
      expect(second.messages[0]!.text).toBe('task3');
    });

    test('removeAgent clears agent cursors', () => {
      addAgent('a', 'worker', mkRoom('r').id, '%100');
      advanceCursor('a', 'r', 5);
      expect(getCursor('a', 'r')).toBe(5);

      removeAgent('a', 'r');
      expect(getCursor('a', 'r')).toBe(0);
    });

    test('removeAgentFully clears agent cursors', () => {
      addAgent('a', 'worker', mkRoom('r').id, '%100');
      advanceCursor('a', 'r', 7);
      expect(getCursor('a', 'r')).toBe(7);

      removeAgentFully('a');
      expect(getCursor('a', 'r')).toBe(0);
    });
  });

  describe('Task CRUD', () => {
    beforeEach(() => {
      clearState();
      addAgent('lead-1', 'leader', mkRoom('frontend').id, '%1');
      addAgent('worker-1', 'worker', mkRoom('frontend').id, '%2');
    });

    test('createTask creates a task with status sent', () => {
      const task = createTask(
        'frontend',
        'worker-1',
        'lead-1',
        1,
        'Build login form',
      );
      expect(task.id).toBeGreaterThan(0);
      expect(task.status).toBe('sent');
      expect(task.assigned_to).toBe('worker-1');
      expect(task.created_by).toBe('lead-1');
      expect(task.summary).toBe('Build login form');
      expect(task.room_id).toBe(getRoom('frontend')!.id);
      expect(task.message_id).toBe(1);
    });

    test('getTask retrieves task by id', () => {
      const created = createTask(
        'frontend',
        'worker-1',
        'lead-1',
        null,
        'Test task',
      );
      const fetched = getTask(created.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.summary).toBe('Test task');
    });

    test('getTask returns undefined for non-existent id', () => {
      expect(getTask(999)).toBeUndefined();
    });

    test('getTasksForAgent returns tasks by status', () => {
      createTask('frontend', 'worker-1', 'lead-1', null, 'Task A');
      createTask('frontend', 'worker-1', 'lead-1', null, 'Task B');
      const tasks = getTasksForAgent('worker-1');
      expect(tasks.length).toBe(2);
    });

    test('getTasksForAgent filters by status', () => {
      const t1 = createTask('frontend', 'worker-1', 'lead-1', null, 'Task A');
      createTask('frontend', 'worker-1', 'lead-1', null, 'Task B');
      updateTaskStatus(t1.id, 'active');
      const active = getTasksForAgent('worker-1', ['active']);
      expect(active.length).toBe(1);
      expect(active[0]!.status).toBe('active');
    });

    test('updateTaskStatus transitions valid states', () => {
      const task = createTask('frontend', 'worker-1', 'lead-1', null, 'Task');
      // sent → active
      const updated = updateTaskStatus(task.id, 'active');
      expect(updated).toBeDefined();
      expect(updated!.status).toBe('active');
      // active → completed
      const done = updateTaskStatus(task.id, 'completed');
      expect(done!.status).toBe('completed');
    });

    test('updateTaskStatus stores note', () => {
      const task = createTask('frontend', 'worker-1', 'lead-1', null, 'Task');
      updateTaskStatus(task.id, 'error', 'Something broke');
      const fetched = getTask(task.id);
      expect(fetched!.note).toBe('Something broke');
    });

    test('updateTaskStatus rejects invalid transitions', () => {
      const task = createTask('frontend', 'worker-1', 'lead-1', null, 'Task');
      updateTaskStatus(task.id, 'active');
      updateTaskStatus(task.id, 'completed');
      // completed → active is not valid
      expect(() => updateTaskStatus(task.id, 'active')).toThrow(
        'Invalid transition',
      );
    });

    test('updateTaskStatus returns undefined for non-existent task', () => {
      expect(updateTaskStatus(999, 'active')).toBeUndefined();
    });

    test('cleanupDeadAgentTasks transitions non-terminal tasks to error', () => {
      const t1 = createTask(
        'frontend',
        'worker-1',
        'lead-1',
        null,
        'Active task',
      );
      updateTaskStatus(t1.id, 'active');
      const t2 = createTask(
        'frontend',
        'worker-1',
        'lead-1',
        null,
        'Queued task',
      );
      updateTaskStatus(t2.id, 'queued');
      const t3 = createTask(
        'frontend',
        'worker-1',
        'lead-1',
        null,
        'Completed task',
      );
      updateTaskStatus(t3.id, 'active');
      updateTaskStatus(t3.id, 'completed');

      cleanupDeadAgentTasks('worker-1');

      // Active and queued should be error
      expect(getTask(t1.id)!.status).toBe('error');
      expect(getTask(t1.id)!.note).toBe('agent pane died');
      expect(getTask(t2.id)!.status).toBe('error');
      // Completed should be unchanged
      expect(getTask(t3.id)!.status).toBe('completed');
    });

    test('validateLiveness cleans up tasks for dead agents', async () => {
      // This test uses a fake pane that doesn't exist — isPaneDead returns true
      addAgent('dead-worker', 'worker', mkRoom('frontend').id, '%99999');
      const task = createTask(
        'frontend',
        'dead-worker',
        'lead-1',
        null,
        'Doomed task',
      );
      updateTaskStatus(task.id, 'active');

      await validateLiveness();

      const updated = getTask(task.id);
      expect(updated!.status).toBe('error');
      expect(updated!.note).toBe('agent pane died');
    });

    test('validateLiveness removes agents with dead tmux panes', async () => {
      // Register an agent with a fake (dead) tmux pane
      // Args: name, role, room, tmuxTarget
      addAgent('ghost-agent', 'worker', mkRoom('crew').id, '%99999');
      const before = getAgent('ghost-agent');
      expect(before).toBeTruthy();

      // Run liveness check — should detect fake pane as dead and remove
      const dead = await validateLiveness();
      expect(dead).toContain('ghost-agent');

      // Agent should be gone from DB
      const after = getAgent('ghost-agent');
      expect(after).toBeUndefined();
    });
  });

  describe('token_usage table', () => {
    test('token_usage table exists', () => {
      const db = require('../src/state/db.ts').getDb();
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='token_usage'",
        )
        .get();
      expect(row).toBeTruthy();
    });

    test('pricing table exists with defaults', () => {
      const db = require('../src/state/db.ts').getDb();
      const rows = db.prepare('SELECT * FROM pricing').all();
      expect(rows.length).toBeGreaterThan(0);
      const models = rows.map((r: any) => r.model_name);
      expect(models).toContain('claude-opus-4-6');
      expect(models).toContain('gpt-4.1');
    });
  });

  describe('token usage CRUD', () => {
    test('recordTokenUsage inserts a row', () => {
      clearState();
      const wk = addAgent('wk-01', 'worker', mkRoom('billing').id, '%71');
      recordTokenUsage({
        agent_id: wk.agent_id,
        session_id: 'sess-123',
        model: 'claude-opus-4-6',
        input_tokens: 1000,
        output_tokens: 500,
        cost_usd: 0.05,
        source: 'statusline',
      });
      const rows = getTokenUsageForAgent('wk-01');
      expect(rows.length).toBe(1);
      expect(rows[0]!.cost_usd).toBe(0.05);
    });

    test('getTokenUsageForAgent returns only that agent', () => {
      clearState();
      const wk1 = addAgent('wk-01', 'worker', mkRoom('billing').id, '%72');
      const wk2 = addAgent('wk-02', 'worker', mkRoom('billing').id, '%73');
      recordTokenUsage({
        agent_id: wk1.agent_id,
        session_id: 's1',
        model: 'o3',
        input_tokens: 100,
        output_tokens: 50,
        cost_usd: 0.01,
        source: 'codex_db',
      });
      recordTokenUsage({
        agent_id: wk2.agent_id,
        session_id: 's2',
        model: 'o3',
        input_tokens: 200,
        output_tokens: 100,
        cost_usd: 0.02,
        source: 'codex_db',
      });
      const rows = getTokenUsageForAgent('wk-01');
      expect(rows.length).toBe(1);
    });

    test('getTotalCost sums all agents', () => {
      clearState();
      const a1 = addAgent('a1', 'worker', mkRoom('billing').id, '%74');
      const a2 = addAgent('a2', 'worker', mkRoom('billing').id, '%75');
      recordTokenUsage({
        agent_id: a1.agent_id,
        session_id: 's1',
        model: 'm',
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 1.0,
        source: 'statusline',
      });
      recordTokenUsage({
        agent_id: a2.agent_id,
        session_id: 's2',
        model: 'm',
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 2.5,
        source: 'statusline',
      });
      expect(getTotalCost()).toBeCloseTo(3.5);
    });

    test('recordTokenUsage upserts — second call for same agent updates row, not inserts', () => {
      clearState();
      const wk = addAgent('wk-01', 'worker', mkRoom('billing').id, '%76');
      recordTokenUsage({
        agent_id: wk.agent_id,
        session_id: 's1',
        model: 'o3',
        input_tokens: 100,
        output_tokens: 50,
        cost_usd: 0.01,
        source: 'statusline',
      });
      recordTokenUsage({
        agent_id: wk.agent_id,
        session_id: 's2',
        model: 'gpt-4.1',
        input_tokens: 200,
        output_tokens: 100,
        cost_usd: 0.02,
        source: 'statusline',
      });
      const rows = getTokenUsageForAgent('wk-01');
      expect(rows.length).toBe(1);
      expect(rows[0]!.input_tokens).toBe(200);
      expect(rows[0]!.cost_usd).toBe(0.02);
      expect(rows[0]!.model).toBe('gpt-4.1');
    });

    test('getPricing returns default entries', () => {
      const pricing = getPricing();
      expect(pricing.length).toBeGreaterThan(0);
    });

    test('upsertPricing updates existing model', () => {
      upsertPricing('claude-opus-4-6', 20.0, 100.0);
      const p = getPricing().find((e) => e.model_name === 'claude-opus-4-6');
      expect(p?.input_cost_per_million).toBe(20.0);
    });
  });

  describe('task context sharing', () => {
    test('updateTaskStatus with context stores it', () => {
      addAgent('lead-01', 'leader', mkRoom('test-room').id, '%79');
      addAgent('wk-01', 'worker', mkRoom('test-room').id, '%80');
      const task = createTask(
        'test-room',
        'wk-01',
        'lead-01',
        null,
        'test task summary',
      );
      updateTaskStatus(task.id, 'active');
      updateTaskStatus(
        task.id,
        'completed',
        'done',
        'Explored src/auth.ts. Found JWT validation in middleware.',
      );
      const details = getTaskDetails(task.id);
      expect(details).toBeTruthy();
      expect(details!.context).toContain('JWT validation');
    });

    test('searchTasks by keyword finds matching tasks', () => {
      addAgent('lead-01', 'leader', mkRoom('test-room').id, '%81');
      addAgent('wk-01', 'worker', mkRoom('test-room').id, '%82');
      const t1 = createTask(
        'test-room',
        'wk-01',
        'lead-01',
        null,
        'fix auth middleware',
      );
      updateTaskStatus(t1.id, 'active');
      updateTaskStatus(
        t1.id,
        'completed',
        undefined,
        'JWT tokens expire too early',
      );

      const results = searchTasks({ keyword: 'JWT' });
      expect(results.length).toBeGreaterThan(0);
    });

    test('searchTasks by room filters correctly', () => {
      addAgent('lead-01', 'leader', mkRoom('room-ctx-a').id, '%83');
      addAgent('wk-01', 'worker', mkRoom('room-ctx-a').id, '%84');
      createTask('room-ctx-a', 'wk-01', 'lead-01', null, 'task in room a');
      const results = searchTasks({ room: 'room-ctx-a' });
      expect(results.every((r) => r.room === 'room-ctx-a')).toBe(true);
    });

    test('searchTasks returns context_preview truncated', () => {
      addAgent('lead-01', 'leader', mkRoom('test-room').id, '%85');
      addAgent('wk-01', 'worker', mkRoom('test-room').id, '%86');
      const longCtx = 'x'.repeat(500);
      const t = createTask(
        'test-room',
        'wk-01',
        'lead-01',
        null,
        'long ctx task',
      );
      updateTaskStatus(t.id, 'active');
      updateTaskStatus(t.id, 'completed', undefined, longCtx);
      const results = searchTasks({ keyword: 'long ctx' });
      if (results.length > 0) {
        expect(results[0].context_preview!.length).toBeLessThanOrEqual(203);
      }
    });
  });

  describe('cancelQueuedTasksForAgent', () => {
    beforeEach(() => {
      clearState();
      addAgent('lead-01', 'leader', mkRoom('room').id, '%1');
      addAgent('wk-01', 'worker', mkRoom('room').id, '%2');
    });

    test('cancels queued/sent tasks and returns count', () => {
      const t1 = createTask('room', 'wk-01', 'lead-01', null, 'task a'); // sent
      const t2 = createTask('room', 'wk-01', 'lead-01', null, 'task b');
      updateTaskStatus(t2.id, 'queued');
      const t3 = createTask('room', 'wk-01', 'lead-01', null, 'task c');
      updateTaskStatus(t3.id, 'active'); // should NOT be cancelled

      const n = cancelQueuedTasksForAgent('wk-01', 'lead-01');
      expect(n).toBe(2);

      expect(getTask(t1.id)!.status).toBe('cancelled');
      expect(getTask(t2.id)!.status).toBe('cancelled');
      expect(getTask(t3.id)!.status).toBe('active');
    });

    test('leaves other agents untouched', () => {
      addAgent('wk-02', 'worker', mkRoom('room').id, '%3');
      const mine = createTask('room', 'wk-01', 'lead-01', null, 'mine');
      const theirs = createTask('room', 'wk-02', 'lead-01', null, 'theirs');

      cancelQueuedTasksForAgent('wk-01', 'lead-01');
      expect(getTask(mine.id)!.status).toBe('cancelled');
      expect(getTask(theirs.id)!.status).toBe('sent');
    });

    test('returns 0 when nothing to cancel', () => {
      expect(cancelQueuedTasksForAgent('wk-01', 'lead-01')).toBe(0);
    });

    test('records task_events for cancellations', () => {
      const t = createTask('room', 'wk-01', 'lead-01', null, 'task');
      cancelQueuedTasksForAgent('wk-01', 'lead-01');
      const events = getTaskEvents(t.id);
      const cancelEvent = events.find((e) => e.to_status === 'cancelled');
      expect(cancelEvent).toBeDefined();
      expect(cancelEvent!.triggered_by).toBe('lead-01');
    });
  });

  describe('migrations', () => {
    test('adds context column to pre-existing tasks table (regression)', async () => {
      // Simulate a DB created before `context` was added: build a tasks table
      // without the column, then re-init and ensure searchTasks works.
      const tmpPath = `/tmp/crew-migration-test-${Date.now()}.db`;
      const { Database } = await import('bun:sqlite');

      closeDb();
      const raw = new Database(tmpPath, { create: true });
      raw.exec(`
        CREATE TABLE rooms (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          topic TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          room_id INTEGER NOT NULL,
          assigned_to TEXT NOT NULL,
          created_by TEXT NOT NULL,
          message_id INTEGER,
          summary TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'sent',
          note TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      raw.close();

      initDb(tmpPath);
      // Should not throw — schema init on existing DB should complete
      const results = searchTasks({ keyword: 'queued' });
      expect(Array.isArray(results)).toBe(true);

      closeDb();
      const { unlinkSync } = await import('fs');
      try {
        unlinkSync(tmpPath);
      } catch {}
      try {
        unlinkSync(tmpPath + '-wal');
      } catch {}
      try {
        unlinkSync(tmpPath + '-shm');
      } catch {}
    });
  });

  describe('task events', () => {
    beforeEach(() => {
      clearState();
      addAgent('lead-01', 'leader', mkRoom('test-room').id, '%1');
      addAgent('wk-01', 'worker', mkRoom('test-room').id, '%2');
    });

    test('recordTaskEvent stores a transition', () => {
      const task = createTask(
        'test-room',
        'wk-01',
        'lead-01',
        null,
        'event test',
      );
      recordTaskEvent(task.id, null, 'sent', 'system');
      const events = getTaskEvents(task.id);
      expect(events.length).toBe(2);
      expect(events[1]!.to_status).toBe('sent');
      expect(events[1]!.triggered_by).toBe('system');
    });

    test('getTaskEvents returns events in order', () => {
      const task = createTask(
        'test-room',
        'wk-01',
        'lead-01',
        null,
        'multi event',
      );
      recordTaskEvent(task.id, null, 'sent', 'system');
      recordTaskEvent(task.id, 'sent', 'active', 'wk-01');
      recordTaskEvent(task.id, 'active', 'completed', 'wk-01');
      const events = getTaskEvents(task.id);
      expect(events.length).toBe(4);
      expect(events[3]!.to_status).toBe('completed');
    });

    test('getAllTaskEvents returns array', () => {
      expect(Array.isArray(getAllTaskEvents())).toBe(true);
    });

    test('updateTaskStatus auto-records event', () => {
      const task = createTask(
        'test-room',
        'wk-01',
        'lead-01',
        null,
        'auto event',
      );
      // Task starts with status 'sent'
      updateTaskStatus(task.id, 'active', undefined, undefined, 'wk-01');
      const events = getTaskEvents(task.id);
      expect(events.length).toBe(2);
      expect(events[1]!.from_status).toBe('sent');
      expect(events[1]!.to_status).toBe('active');
      expect(events[1]!.triggered_by).toBe('wk-01');
    });

    test('createTask produces initial task_event', () => {
      const task = createTask(
        'test-room',
        'wk-01',
        'lead-01',
        null,
        'initial event task',
      );
      const events = getTaskEvents(task.id);
      expect(events.length).toBe(1);
      expect(events[0]!.from_status).toBeNull();
      expect(events[0]!.to_status).toBe('sent');
      expect(events[0]!.triggered_by).toBe('lead-01');
    });
  });

  describe('change detection', () => {
    beforeEach(() => {
      clearState();
      addAgent('lead-01', 'leader', mkRoom('test-room').id, '%1');
      addAgent('wk-01', 'worker', mkRoom('test-room').id, '%2');
    });

    test('change_log table has initial rows after initDb', () => {
      const db = require('../src/state/db.ts').getDb();
      const rows = db.prepare('SELECT * FROM change_log').all() as {
        scope: string;
        version: number;
      }[];
      expect(rows.length).toBe(8);
      const scopes = rows.map((r) => r.scope).sort();
      expect(scopes).toEqual([
        'agents',
        'hints',
        'hook-events',
        'messages',
        'party',
        'room-templates',
        'tasks',
        'templates',
      ]);
    });

    test('Inserting a message bumps messages version', () => {
      const before = getChangeVersions(['messages']);
      const v1 = before['messages']?.version ?? 0;
      addMessage('wk-01', 'lead-01', 'test-room', 'hello', 'push', 'wk-01');
      const after = getChangeVersions(['messages']);
      const v2 = after['messages']?.version ?? 0;
      expect(v2).toBeGreaterThan(v1);
    });

    test('Inserting a task bumps tasks version', () => {
      const before = getChangeVersions(['tasks']);
      const v1 = before['tasks']?.version ?? 0;
      createTask('test-room', 'wk-01', 'lead-01', null, 'test task');
      const after = getChangeVersions(['tasks']);
      const v2 = after['tasks']?.version ?? 0;
      expect(v2).toBeGreaterThan(v1);
    });

    test('Updating a task bumps tasks version', () => {
      const task = createTask(
        'test-room',
        'wk-01',
        'lead-01',
        null,
        'test task',
      );
      const before = getChangeVersions(['tasks']);
      const v1 = before['tasks']?.version ?? 0;
      updateTaskStatus(task.id, 'active');
      const after = getChangeVersions(['tasks']);
      const v2 = after['tasks']?.version ?? 0;
      expect(v2).toBeGreaterThan(v1);
    });

    test('Inserting an agent bumps agents version', () => {
      const before = getChangeVersions(['agents']);
      const v1 = before['agents']?.version ?? 0;
      addAgent('new-agent', 'worker', mkRoom('test-room').id, '%3');
      const after = getChangeVersions(['agents']);
      const v2 = after['agents']?.version ?? 0;
      expect(v2).toBeGreaterThan(v1);
    });

    test('getChangeVersions returns correct versions', () => {
      const versions = getChangeVersions(['messages', 'tasks', 'agents']);
      expect(versions['messages']).toBeDefined();
      expect(versions['tasks']).toBeDefined();
      expect(versions['agents']).toBeDefined();
      expect(typeof versions['messages']?.version).toBe('number');
      expect(typeof versions['messages']?.updated_at).toBe('string');
    });

    test('getChangeVersions filters by requested scopes', () => {
      const versions = getChangeVersions(['messages']);
      expect(versions['messages']).toBeDefined();
      expect(versions['tasks']).toBeUndefined();
      expect(versions['agents']).toBeUndefined();
    });
  });

  describe('registered-agent hints', () => {
    beforeEach(() => {
      clearState();
    });

    test('setHint creates a pane-bootstrap record', () => {
      const room = mkRoom('test-room');
      const agent = addAgent('test-agent', 'worker', room.id, '%100');
      const hint = setHint('test-agent', room.id, '%100');

      expect(hint.agent_name).toBe('test-agent');
      expect(hint.pane_bootstrap).toBe('%100');
      expect(hint.session_id).toBeNull();
      expect(hint.turn_count).toBe(0);
    });

    test('setHint uses agent pane if not provided', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%101');
      const hint = setHint('test-agent', room.id);

      expect(hint.pane_bootstrap).toBe('%101');
    });

    test('getHint returns pane-bootstrap hint before canonicalization', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%102');
      setHint('test-agent', room.id, '%102');

      const hint = getHint('%102', null);
      expect(hint).toBeDefined();
      expect(hint!.agent_name).toBe('test-agent');
    });

    test('getHint returns session-bound hint after canonicalization', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%103');
      setHint('test-agent', room.id, '%103');

      // Canonicalize to session
      canonicalizeHintIdentity('test-agent', '%103', 'sess-123');

      // Hint now found by session_id, not pane
      const hintBySession = getHint('%103', 'sess-123');
      expect(hintBySession).toBeDefined();
      expect(hintBySession!.session_id).toBe('sess-123');
      // pane_bootstrap is preserved after canonicalization so getHint(pane, null) still works
      expect(hintBySession!.pane_bootstrap).toBe('%103');
    });

    test('canonicalizeHintIdentity is idempotent', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%104');
      setHint('test-agent', room.id, '%104');

      canonicalizeHintIdentity('test-agent', '%104', 'sess-456');
      canonicalizeHintIdentity('test-agent', '%104', 'sess-456'); // Second call

      const hint = getHint('%104', 'sess-456');
      expect(hint).toBeDefined();
      expect(hint!.session_id).toBe('sess-456');
    });

    test('canonicalizeHintIdentity retires stale session-bound row on Claude restart same pane', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%200');
      setHint('test-agent', room.id, '%200');
      // First Claude session: pane migrates to session S1
      canonicalizeHintIdentity('test-agent', '%200', 'S1');
      expect(getHint('%200', 'S1')?.session_id).toBe('S1');

      // Claude restarts on the same pane producing a new session S2.
      // Without cleanup, the prior S1 row would survive with pane_bootstrap=NULL
      // and canonicalize would find no pane-bootstrap row to migrate.
      canonicalizeHintIdentity('test-agent', '%200', 'S2');

      // S1 row must be gone; a row for S2 must exist (or tickHintCadence would be silent forever).
      expect(getHint('%200', 'S1')).toBeNull();
      const after = getHint('%200', 'S2');
      expect(after?.session_id).toBe('S2');
      expect(after?.agent_name).toBe('test-agent');
    });

    test('tickHintCadence increments turn count', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%105');
      setHint('test-agent', room.id, '%105');

      const result1 = tickHintCadence('%105', null);
      expect(result1.shouldShow).toBe(false); // Turn 1

      const result2 = tickHintCadence('%105', null);
      expect(result2.shouldShow).toBe(false); // Turn 2

      const result3 = tickHintCadence('%105', null);
      expect(result3.shouldShow).toBe(true); // Turn 3
      expect(result3.hint).toBeDefined();
    });

    test('tickHintCadence shows hint on turns 3, 6, 9', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%106');
      setHint('test-agent', room.id, '%106');

      const showTurns: number[] = [];
      for (let i = 1; i <= 9; i++) {
        const result = tickHintCadence('%106', null);
        if (result.shouldShow) showTurns.push(i);
      }

      expect(showTurns).toEqual([3, 6, 9]);
    });

    test('tickHintCadence works with session-bound hints', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%107');
      setHint('test-agent', room.id, '%107');
      canonicalizeHintIdentity('test-agent', '%107', 'sess-789');

      const result1 = tickHintCadence('%107', 'sess-789');
      expect(result1.shouldShow).toBe(false); // Turn 1

      const result2 = tickHintCadence('%107', 'sess-789');
      expect(result2.shouldShow).toBe(false); // Turn 2

      const result3 = tickHintCadence('%107', 'sess-789');
      expect(result3.shouldShow).toBe(true); // Turn 3
      expect(result3.hint!.session_id).toBe('sess-789');
    });

    test('unsetHint removes both pane-bootstrap and session-bound hints', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%108');
      setHint('test-agent', room.id, '%108');

      expect(getHint('%108', null)).toBeDefined();

      const removed = unsetHint('test-agent', room.id);
      expect(removed).toBe(true);
      expect(getHint('%108', null)).toBeNull();
    });

    test('unsetHint returns false when no hint exists', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%109');

      const removed = unsetHint('test-agent', room.id);
      expect(removed).toBe(false);
    });

    test('new session on same pane does not inherit old hint', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%110');
      setHint('test-agent', room.id, '%110');

      // Canonicalize to first session
      canonicalizeHintIdentity('test-agent', '%110', 'sess-old');

      // Simulate session rotation: new session_id on same pane
      // The old hint should not be found by new session
      const newSessionHint = getHint('%110', 'sess-new');
      expect(newSessionHint).toBeNull();

      // Old session hint should still exist
      const oldSessionHint = getHint('%110', 'sess-old');
      expect(oldSessionHint).toBeDefined();
    });

    test('setHint clears existing hint for agent in room', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%111');
      setHint('test-agent', room.id, '%111');

      // Set again - should replace, not duplicate
      const hint2 = setHint('test-agent', room.id, '%111');

      // Should only have one hint record
      const db = require('../src/state/db.ts').getDb();
      const count = db
        .prepare('SELECT COUNT(*) as c FROM agent_hints WHERE agent_name = ? AND room_id = ?')
        .get('test-agent', room.id) as { c: number };
      expect(count.c).toBe(1);
    });

    test('hint without pane or session returns no hint', () => {
      const hint = getHint('%999', null);
      expect(hint).toBeNull();
    });

    test('getHint with wrong session returns null (no pane cross-fallback)', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%112');
      setHint('test-agent', room.id, '%112');

      // getHint(pane, sessionId) is strict: only matches by session_id when provided.
      // No cross-fallback to pane — that's tickHintCadence's job via COALESCE.
      const hint = getHint('%112', 'sess-missing');
      expect(hint).toBeNull();

      // Pane-only lookup works
      const hintByPane = getHint('%112', null);
      expect(hintByPane).toBeDefined();
      expect(hintByPane!.agent_name).toBe('test-agent');
    });

    test('tickHintCadence falls back to pane bootstrap when session row is missing', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%113');
      setHint('test-agent', room.id, '%113');

      expect(tickHintCadence('%113', 'sess-missing').shouldShow).toBe(false);
      expect(tickHintCadence('%113', 'sess-missing').shouldShow).toBe(false);
      expect(tickHintCadence('%113', 'sess-missing').shouldShow).toBe(true);
    });

    test('removeAgent clears pane-bootstrap hints so a reused pane starts clean', () => {
      const room = mkRoom('test-room');
      addAgent('old-agent', 'worker', room.id, '%114');
      setHint('old-agent', room.id, '%114');

      expect(removeAgent('old-agent', 'test-room')).toBe(true);
      expect(getHint('%114', null)).toBeNull();

      const recycledRoom = mkRoom('test-room');
      addAgent('new-agent', 'worker', recycledRoom.id, '%114');
      const hint = setHint('new-agent', recycledRoom.id, '%114');
      expect(hint.agent_name).toBe('new-agent');
      expect(getHint('%114', null)?.agent_name).toBe('new-agent');
    });

    test('removeAgentFully clears hints across rooms for the removed agent', () => {
      const roomA = mkRoom('room-a');
      const roomB = mkRoom('room-b');
      addAgent('shared-agent', 'worker', roomA.id, '%115');
      addAgent('shared-agent', 'worker', roomB.id, '%116');
      setHint('shared-agent', roomA.id, '%115');
      setHint('shared-agent', roomB.id, '%116');

      removeAgentFully('shared-agent');

      expect(getHint('%115', null)).toBeNull();
      expect(getHint('%116', null)).toBeNull();
    });

    test('clearState clears hint and hook-event tables', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%117');
      setHint('test-agent', room.id, '%117');
      addHookEvent('test-agent', 'UserPromptSubmit', 'sess-clear', '{}');

      clearState();

      const db = require('../src/state/db.ts').getDb();
      const hintCount = db.query('SELECT COUNT(*) as c FROM agent_hints').get() as { c: number };
      const hookEventCount = db.query('SELECT COUNT(*) as c FROM hook_events').get() as { c: number };
      expect(hintCount.c).toBe(0);
      expect(hookEventCount.c).toBe(0);
    });

    // ===== Regression tests for e2e-discovered bugs =====

    test('BUG-1: setHint works for same agent with same pane across rooms', () => {
      const roomA = mkRoom('room-a');
      const roomB = mkRoom('room-b');
      addAgent('multi-agent', 'worker', roomA.id, '%200');
      addAgent('multi-agent', 'worker', roomB.id, '%200');

      // Both setHint calls use the same pane — should not crash with UNIQUE constraint
      const hintA = setHint('multi-agent', roomA.id, '%200');
      expect(hintA.agent_name).toBe('multi-agent');
      expect(hintA.room_id).toBe(roomA.id);

      const hintB = setHint('multi-agent', roomB.id, '%200');
      expect(hintB.agent_name).toBe('multi-agent');
      expect(hintB.room_id).toBe(roomB.id);
    });

    test('BUG-2: canonicalizeHintIdentity works across rooms with shared pane', () => {
      const roomA = mkRoom('room-a2');
      const roomB = mkRoom('room-b2');
      addAgent('multi-agent2', 'worker', roomA.id, '%201');
      addAgent('multi-agent2', 'worker', roomB.id, '%201');

      setHint('multi-agent2', roomA.id, '%201');
      setHint('multi-agent2', roomB.id, '%201');

      // Canonicalize both — should not crash with UNIQUE constraint on session_id
      canonicalizeHintIdentity('multi-agent2', '%201', 'sess-shared-1');
      canonicalizeHintIdentity('multi-agent2', '%201', 'sess-shared-2');

      // Only one agent resolved via getAgentByPane — the other canonicalize returns
      // early because getAgentByPane returns one agent. But neither should crash.
    });

    test('BUG-3: getHint(pane, null) works after canonicalization', () => {
      const room = mkRoom('room-c3');
      addAgent('pane-agent', 'worker', room.id, '%202');
      setHint('pane-agent', room.id, '%202');

      canonicalizeHintIdentity('pane-agent', '%202', 'sess-after');

      // pane_bootstrap is preserved, so pane-only lookup still works
      const hint = getHint('%202', null);
      expect(hint).toBeDefined();
      expect(hint!.agent_name).toBe('pane-agent');
      expect(hint!.session_id).toBe('sess-after');
      expect(hint!.pane_bootstrap).toBe('%202');
    });

    test('multi-room: tickHintCadence with roomId scopes correctly', () => {
      const roomA = mkRoom('room-ta');
      const roomB = mkRoom('room-tb');
      addAgent('tick-agent', 'worker', roomA.id, '%203');
      addAgent('tick-agent', 'worker', roomB.id, '%204');

      setHint('tick-agent', roomA.id, '%203');
      setHint('tick-agent', roomB.id, '%204');

      // Tick room A 3 times
      tickHintCadence('%203', null, roomA.id);
      tickHintCadence('%203', null, roomA.id);
      const rA = tickHintCadence('%203', null, roomA.id);
      expect(rA.shouldShow).toBe(true);
      expect(rA.hint?.room_id).toBe(roomA.id);

      // Room B should still be at turn 0
      const hintB = getHint('%204', null);
      expect(hintB?.turn_count).toBe(0);
    });
  });
});
