import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { initDb, closeDb } from '../src/state/db.ts';
import {
  addAgent, getAgent, removeAgent, getRoom, getAllRooms,
  getRoomMembers, isNameTakenInRoom, addMessage, readMessages,
  getRoomMessages, getCursor, advanceCursor, readRoomMessages,
  clearState, removeAgentFully, validateLiveness,
  createTask, getTask, getTasksForAgent, updateTaskStatus, cleanupDeadAgentTasks,
  getTaskDetails, searchTasks,
  recordTaskEvent, getTaskEvents, getAllTaskEvents,
  recordTokenUsage, getTokenUsageForAgent, getTotalCost, getPricing, upsertPricing,
  getChangeVersions,
} from '../src/state/index.ts';

describe('state module', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  describe('agents', () => {
    test('adds and retrieves an agent', () => {
      const agent = addAgent('boss', 'boss', 'company', '%100');
      expect(agent.name).toBe('boss');
      expect(agent.role).toBe('boss');
      expect(agent.rooms).toEqual(['company']);
      expect(getAgent('boss')).toBeDefined();
    });

    test('agent joins multiple rooms', () => {
      addAgent('lead-1', 'leader', 'company', '%101');
      addAgent('lead-1', 'leader', 'frontend', '%101');
      const agent = getAgent('lead-1');
      expect(agent?.rooms).toEqual(['company', 'frontend']);
    });

    test('removes agent from room', () => {
      addAgent('worker-1', 'worker', 'frontend', '%102');
      removeAgent('worker-1', 'frontend');
      expect(getAgent('worker-1')).toBeUndefined();
    });

    test('agent with multiple rooms: removing one keeps others', () => {
      addAgent('lead-1', 'leader', 'company', '%101');
      addAgent('lead-1', 'leader', 'frontend', '%101');
      removeAgent('lead-1', 'frontend');
      const agent = getAgent('lead-1');
      expect(agent?.rooms).toEqual(['company']);
    });
  });

  describe('rooms', () => {
    test('creates room on first agent join', () => {
      addAgent('boss', 'boss', 'company', '%100');
      const room = getRoom('company');
      expect(room).toBeDefined();
      expect(room!.members).toEqual(['boss']);
    });

    test('room tracks all members', () => {
      addAgent('boss', 'boss', 'company', '%100');
      addAgent('lead-1', 'leader', 'company', '%101');
      const room = getRoom('company');
      expect(room!.members).toEqual(['boss', 'lead-1']);
    });

    test('room is deleted when last member leaves', () => {
      addAgent('worker-1', 'worker', 'temp', '%102');
      removeAgent('worker-1', 'temp');
      expect(getRoom('temp')).toBeUndefined();
    });

    test('getAllRooms returns all rooms', () => {
      addAgent('boss', 'boss', 'company', '%100');
      addAgent('worker-1', 'worker', 'frontend', '%102');
      expect(getAllRooms().length).toBe(2);
    });

    test('getRoomMembers returns agents', () => {
      addAgent('boss', 'boss', 'company', '%100');
      addAgent('lead-1', 'leader', 'company', '%101');
      const members = getRoomMembers('company');
      expect(members.length).toBe(2);
      expect(members.map(m => m.name)).toEqual(['boss', 'lead-1']);
    });

    test('isNameTakenInRoom detects duplicates', () => {
      addAgent('boss', 'boss', 'company', '%100');
      expect(isNameTakenInRoom('boss', 'company')).toBe(true);
      expect(isNameTakenInRoom('boss', 'frontend')).toBe(false);
      expect(isNameTakenInRoom('nobody', 'company')).toBe(false);
    });
  });

  describe('messages', () => {
    test('adds and reads messages', () => {
      addAgent('sender', 'leader', 'room', '%100');
      addAgent('receiver', 'worker', 'room', '%101');

      addMessage('receiver', 'sender', 'room', 'hello', 'push', 'receiver');
      addMessage('receiver', 'sender', 'room', 'world', 'push', 'receiver');

      const result = readMessages('receiver');
      expect(result.messages.length).toBe(2);
      expect(result.messages[0]!.text).toBe('hello');
      expect(result.messages[1]!.text).toBe('world');
    });

    test('cursor-based reading with since_sequence', () => {
      addAgent('a', 'worker', 'r', '%100');
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
      addAgent('a', 'worker', 'room1', '%100');
      addMessage('a', 'b', 'room1', 'hello', 'push', 'a');
      addMessage('a', 'b', 'room2', 'world', 'push', 'a');

      const result = readMessages('a', 'room1');
      expect(result.messages.length).toBe(1);
      expect(result.messages[0]!.room).toBe('room1');
    });

    test('message has kind field', () => {
      addAgent('a', 'worker', 'r', '%100');
      addAgent('b', 'leader', 'r', '%101');
      const msg = addMessage('a', 'b', 'r', 'hello', 'push', 'a', 'chat');
      expect(msg.kind).toBe('chat');
    });

    test('message kind defaults to chat', () => {
      addAgent('a', 'worker', 'r', '%100');
      addAgent('b', 'leader', 'r', '%101');
      const msg = addMessage('a', 'b', 'r', 'hello', 'push', 'a');
      expect(msg.kind).toBe('chat');
    });
  });

  describe('room messages', () => {
    test('message is stored in room log', () => {
      addAgent('a', 'leader', 'frontend', '%100');
      addAgent('b', 'worker', 'frontend', '%101');
      addMessage('b', 'a', 'frontend', 'build login', 'push', 'b', 'task');

      const roomMsgs = getRoomMessages('frontend');
      expect(roomMsgs.length).toBe(1);
      expect(roomMsgs[0]!.text).toBe('build login');
      expect(roomMsgs[0]!.from).toBe('a');
    });

    test('all room members can read room messages', () => {
      addAgent('lead', 'leader', 'frontend', '%100');
      addAgent('w1', 'worker', 'frontend', '%101');
      addAgent('w2', 'worker', 'frontend', '%102');

      addMessage('w1', 'lead', 'frontend', 'build login', 'push', 'w1', 'task');

      const roomMsgs = getRoomMessages('frontend');
      expect(roomMsgs.length).toBe(1);
    });

    test('broadcast is one canonical message', () => {
      addAgent('lead', 'leader', 'team', '%100');
      addAgent('w1', 'worker', 'team', '%101');
      addAgent('w2', 'worker', 'team', '%102');

      addMessage('__room__', 'lead', 'team', 'standup', 'push', null, 'chat');

      const roomMsgs = getRoomMessages('team');
      expect(roomMsgs.length).toBe(1);
      expect(roomMsgs[0]!.to).toBeNull();
    });
  });

  describe('cursors', () => {
    test('getCursor returns 0 for new agent-room pair', () => {
      addAgent('a', 'worker', 'r', '%100');
      expect(getCursor('a', 'r')).toBe(0);
    });

    test('advanceCursor updates read position', () => {
      addAgent('a', 'worker', 'r', '%100');
      advanceCursor('a', 'r', 5);
      expect(getCursor('a', 'r')).toBe(5);
    });

    test('readRoomMessages advances cursor', () => {
      addAgent('lead', 'leader', 'r', '%100');
      addAgent('w1', 'worker', 'r', '%101');

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
      addAgent('a', 'worker', 'r', '%100');
      advanceCursor('a', 'r', 5);
      expect(getCursor('a', 'r')).toBe(5);

      removeAgent('a', 'r');
      expect(getCursor('a', 'r')).toBe(0);
    });

    test('removeAgentFully clears agent cursors', () => {
      addAgent('a', 'worker', 'r', '%100');
      advanceCursor('a', 'r', 7);
      expect(getCursor('a', 'r')).toBe(7);

      removeAgentFully('a');
      expect(getCursor('a', 'r')).toBe(0);
    });
  });

  describe('Task CRUD', () => {
    beforeEach(() => {
      clearState();
      addAgent('lead-1', 'leader', 'frontend', '%1');
      addAgent('worker-1', 'worker', 'frontend', '%2');
    });

    test('createTask creates a task with status sent', () => {
      const task = createTask('frontend', 'worker-1', 'lead-1', 1, 'Build login form');
      expect(task.id).toBeGreaterThan(0);
      expect(task.status).toBe('sent');
      expect(task.assigned_to).toBe('worker-1');
      expect(task.created_by).toBe('lead-1');
      expect(task.summary).toBe('Build login form');
      expect(task.room).toBe('frontend');
      expect(task.message_id).toBe(1);
    });

    test('getTask retrieves task by id', () => {
      const created = createTask('frontend', 'worker-1', 'lead-1', null, 'Test task');
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
      expect(() => updateTaskStatus(task.id, 'active')).toThrow('Invalid transition');
    });

    test('updateTaskStatus returns undefined for non-existent task', () => {
      expect(updateTaskStatus(999, 'active')).toBeUndefined();
    });

    test('cleanupDeadAgentTasks transitions non-terminal tasks to error', () => {
      const t1 = createTask('frontend', 'worker-1', 'lead-1', null, 'Active task');
      updateTaskStatus(t1.id, 'active');
      const t2 = createTask('frontend', 'worker-1', 'lead-1', null, 'Queued task');
      updateTaskStatus(t2.id, 'queued');
      const t3 = createTask('frontend', 'worker-1', 'lead-1', null, 'Completed task');
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
      addAgent('dead-worker', 'worker', 'frontend', '%99999');
      const task = createTask('frontend', 'dead-worker', 'lead-1', null, 'Doomed task');
      updateTaskStatus(task.id, 'active');

      await validateLiveness();

      const updated = getTask(task.id);
      expect(updated!.status).toBe('error');
      expect(updated!.note).toBe('agent pane died');
    });

    test('validateLiveness removes agents with dead tmux panes', async () => {
      // Register an agent with a fake (dead) tmux pane
      addAgent('ghost-agent', 'worker', '%99999', 'crew');
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
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='token_usage'").get();
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
      recordTokenUsage({
        agent_name: 'wk-01', session_id: 'sess-123', model: 'claude-opus-4-6',
        input_tokens: 1000, output_tokens: 500, cost_usd: 0.05, source: 'statusline',
      });
      const rows = getTokenUsageForAgent('wk-01');
      expect(rows.length).toBe(1);
      expect(rows[0]!.cost_usd).toBe(0.05);
    });

    test('getTokenUsageForAgent returns only that agent', () => {
      recordTokenUsage({ agent_name: 'wk-01', session_id: 's1', model: 'o3', input_tokens: 100, output_tokens: 50, cost_usd: 0.01, source: 'codex_db' });
      recordTokenUsage({ agent_name: 'wk-02', session_id: 's2', model: 'o3', input_tokens: 200, output_tokens: 100, cost_usd: 0.02, source: 'codex_db' });
      const rows = getTokenUsageForAgent('wk-01');
      expect(rows.every(r => r.agent_name === 'wk-01')).toBe(true);
    });

    test('getTotalCost sums all agents', () => {
      recordTokenUsage({ agent_name: 'a1', session_id: 's1', model: 'm', input_tokens: 0, output_tokens: 0, cost_usd: 1.00, source: 'statusline' });
      recordTokenUsage({ agent_name: 'a2', session_id: 's2', model: 'm', input_tokens: 0, output_tokens: 0, cost_usd: 2.50, source: 'statusline' });
      expect(getTotalCost()).toBeCloseTo(3.50);
    });

    test('recordTokenUsage upserts — second call for same agent updates row, not inserts', () => {
      recordTokenUsage({ agent_name: 'wk-01', session_id: 's1', model: 'o3', input_tokens: 100, output_tokens: 50, cost_usd: 0.01, source: 'statusline' });
      recordTokenUsage({ agent_name: 'wk-01', session_id: 's2', model: 'gpt-4.1', input_tokens: 200, output_tokens: 100, cost_usd: 0.02, source: 'statusline' });
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
      const p = getPricing().find(e => e.model_name === 'claude-opus-4-6');
      expect(p?.input_cost_per_million).toBe(20.0);
    });
  });

  describe('task context sharing', () => {
    test('updateTaskStatus with context stores it', () => {
      const task = createTask('test-room', 'wk-01', 'lead-01', null, 'test task summary');
      updateTaskStatus(task.id, 'active');
      updateTaskStatus(task.id, 'completed', 'done', 'Explored src/auth.ts. Found JWT validation in middleware.');
      const details = getTaskDetails(task.id);
      expect(details).toBeTruthy();
      expect(details!.context).toContain('JWT validation');
    });

    test('searchTasks by keyword finds matching tasks', () => {
      const t1 = createTask('test-room', 'wk-01', 'lead-01', null, 'fix auth middleware');
      updateTaskStatus(t1.id, 'active');
      updateTaskStatus(t1.id, 'completed', undefined, 'JWT tokens expire too early');

      const results = searchTasks({ keyword: 'JWT' });
      expect(results.length).toBeGreaterThan(0);
    });

    test('searchTasks by room filters correctly', () => {
      createTask('room-ctx-a', 'wk-01', 'lead-01', null, 'task in room a');
      const results = searchTasks({ room: 'room-ctx-a' });
      expect(results.every(r => r.room === 'room-ctx-a')).toBe(true);
    });

    test('searchTasks returns context_preview truncated', () => {
      const longCtx = 'x'.repeat(500);
      const t = createTask('test-room', 'wk-01', 'lead-01', null, 'long ctx task');
      updateTaskStatus(t.id, 'active');
      updateTaskStatus(t.id, 'completed', undefined, longCtx);
      const results = searchTasks({ keyword: 'long ctx' });
      if (results.length > 0) {
        expect(results[0].context_preview!.length).toBeLessThanOrEqual(203);
      }
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
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          room TEXT NOT NULL,
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
      // Should not throw — the migration must have added `context`
      const results = searchTasks({ status: 'queued' });
      expect(Array.isArray(results)).toBe(true);

      closeDb();
      const { unlinkSync } = await import('fs');
      try { unlinkSync(tmpPath); } catch {}
      try { unlinkSync(tmpPath + '-wal'); } catch {}
      try { unlinkSync(tmpPath + '-shm'); } catch {}
    });
  });

  describe('task events', () => {
    beforeEach(() => {
      clearState();
      addAgent('lead-01', 'leader', 'test-room', '%1');
      addAgent('wk-01', 'worker', 'test-room', '%2');
    });

    test('recordTaskEvent stores a transition', () => {
      const task = createTask('test-room', 'wk-01', 'lead-01', null, 'event test');
      recordTaskEvent(task.id, null, 'sent', 'system');
      const events = getTaskEvents(task.id);
      expect(events.length).toBe(2);
      expect(events[1]!.to_status).toBe('sent');
      expect(events[1]!.triggered_by).toBe('system');
    });

    test('getTaskEvents returns events in order', () => {
      const task = createTask('test-room', 'wk-01', 'lead-01', null, 'multi event');
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
      const task = createTask('test-room', 'wk-01', 'lead-01', null, 'auto event');
      // Task starts with status 'sent'
      updateTaskStatus(task.id, 'active', undefined, undefined, 'wk-01');
      const events = getTaskEvents(task.id);
      expect(events.length).toBe(2);
      expect(events[1]!.from_status).toBe('sent');
      expect(events[1]!.to_status).toBe('active');
      expect(events[1]!.triggered_by).toBe('wk-01');
    });

    test('createTask produces initial task_event', () => {
      const task = createTask('test-room', 'wk-01', 'lead-01', null, 'initial event task');
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
      addAgent('lead-01', 'leader', 'test-room', '%1');
      addAgent('wk-01', 'worker', 'test-room', '%2');
    });

    test('change_log table has 3 initial rows after initDb', () => {
      const db = require('../src/state/db.ts').getDb();
      const rows = db.prepare('SELECT * FROM change_log').all() as { scope: string; version: number }[];
      expect(rows.length).toBe(3);
      const scopes = rows.map(r => r.scope).sort();
      expect(scopes).toEqual(['agents', 'messages', 'tasks']);
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
      const task = createTask('test-room', 'wk-01', 'lead-01', null, 'test task');
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
      addAgent('new-agent', 'worker', 'test-room', '%3');
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
});
