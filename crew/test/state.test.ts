import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  addAgent,
  addHookEvent,
  addMessage,
  advanceCursor,
  canonicalizeHintIdentity,
  clearState,
  completeGoal,
  getAgent,
  getAllRooms,
  getChangeVersions,
  getCursor,
  getHint,
  getOrCreateRoom,
  getPricing,
  getRoom,
  getRoomMembers,
  getRoomMessages,
  getTokenUsageForAgent,
  getTotalCost,
  isNameTakenInRoom,
  readMessages,
  readRoomMessages,
  recordTokenUsage,
  removeAgent,
  removeAgentFully,
  setGoal,
  setHint,
  tickHintCadence,
  unsetGoal,
  unsetHint,
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

    test('getRoom by name prefers the latest matching room row', () => {
      const first = getOrCreateRoom(
        '/test/worktree-a/better-logging',
        'better-logging',
      );
      const second = getOrCreateRoom(
        '/test/worktree-b/better-logging',
        'better-logging',
      );

      expect(first.id).not.toBe(second.id);
      expect(getRoom('better-logging')?.id).toBe(second.id);
      expect(getRoom('better-logging')?.path).toBe(
        '/test/worktree-b/better-logging',
      );
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

      addMessage('receiver', 'sender', 'room', 'hello', 'receiver');
      addMessage('receiver', 'sender', 'room', 'world', 'receiver');

      const result = readMessages('receiver');
      expect(result.messages.length).toBe(2);
      expect(result.messages[0]!.text).toBe('hello');
      expect(result.messages[1]!.text).toBe('world');
    });

    test('cursor-based reading with since_sequence', () => {
      addAgent('a', 'worker', mkRoom('r').id, '%100');
      addMessage('a', 'b', 'r', 'msg1', 'a');
      addMessage('a', 'b', 'r', 'msg2', 'a');

      const first = readMessages('a');
      expect(first.messages.length).toBe(2);

      addMessage('a', 'b', 'r', 'msg3', 'a');
      const second = readMessages('a', undefined, first.next_sequence);
      expect(second.messages.length).toBe(1);
      expect(second.messages[0]!.text).toBe('msg3');
    });

    test('filters by room', () => {
      addAgent('a', 'worker', mkRoom('room1').id, '%100');
      addAgent('b', 'leader', mkRoom('room1').id, '%101');
      addMessage('a', 'b', 'room1', 'hello', 'a');

      const result = readMessages('a', 'room1');
      expect(result.messages.length).toBe(1);
      expect(result.messages[0]!.room_id).toBe(getRoom('room1')!.id);
    });

    test('message is stored with correct fields', () => {
      addAgent('a', 'worker', mkRoom('r').id, '%100');
      addAgent('b', 'leader', mkRoom('r').id, '%101');
      const msg = addMessage('a', 'b', 'r', 'hello', 'a');
      expect(msg.message_id).toBeDefined();
      expect(msg.from).toBe('b');
      expect(msg.to).toBe('a');
      expect(msg.text).toBe('hello');
    });
  });

  describe('room messages', () => {
    test('message is stored in room log', () => {
      addAgent('a', 'leader', mkRoom('frontend').id, '%100');
      addAgent('b', 'worker', mkRoom('frontend').id, '%101');
      addMessage('b', 'a', 'frontend', 'build login', 'b');

      const roomMsgs = getRoomMessages('frontend');
      expect(roomMsgs.length).toBe(1);
      expect(roomMsgs[0]!.text).toBe('build login');
      expect(roomMsgs[0]!.from).toBe('a');
    });

    test('all room members can read room messages', () => {
      addAgent('lead', 'leader', mkRoom('frontend').id, '%100');
      addAgent('w1', 'worker', mkRoom('frontend').id, '%101');
      addAgent('w2', 'worker', mkRoom('frontend').id, '%102');

      addMessage('w1', 'lead', 'frontend', 'build login', 'w1');

      const roomMsgs = getRoomMessages('frontend');
      expect(roomMsgs.length).toBe(1);
    });

    test('broadcast is one canonical message', () => {
      addAgent('lead', 'leader', mkRoom('team').id, '%100');
      addAgent('w1', 'worker', mkRoom('team').id, '%101');
      addAgent('w2', 'worker', mkRoom('team').id, '%102');

      addMessage('__room__', 'lead', 'team', 'standup', null);

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

      addMessage('w1', 'lead', 'r', 'task1', 'w1');
      addMessage('w1', 'lead', 'r', 'task2', 'w1');

      // First read: gets both messages
      const first = readRoomMessages('w1', 'r');
      expect(first.messages.length).toBe(2);

      // Add a third message
      addMessage('w1', 'lead', 'r', 'task3', 'w1');

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

  describe('liveness', () => {
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
        'goals',
        'hints',
        'hook-events',
        'messages',
        'party',
        'room-templates',
        'templates',
      ]);
    });

    test('Inserting a message bumps messages version', () => {
      const before = getChangeVersions(['messages']);
      const v1 = before['messages']?.version ?? 0;
      addMessage('wk-01', 'lead-01', 'test-room', 'hello', 'wk-01');
      const after = getChangeVersions(['messages']);
      const v2 = after['messages']?.version ?? 0;
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
      const versions = getChangeVersions(['messages', 'agents']);
      expect(versions['messages']).toBeDefined();
      expect(versions['agents']).toBeDefined();
      expect(typeof versions['messages']?.version).toBe('number');
      expect(typeof versions['messages']?.updated_at).toBe('string');
    });

    test('getChangeVersions filters by requested scopes', () => {
      const versions = getChangeVersions(['messages']);
      expect(versions['messages']).toBeDefined();
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
      const hint = setHint('test-agent', room.id, 'Test hint message', {
        pane: '%100',
      });

      expect(hint.agent_name).toBe('test-agent');
      expect(hint.pane_bootstrap).toBe('%100');
      expect(hint.session_id).toBeNull();
      expect(hint.turn_count).toBe(0);
    });

    test('setHint uses agent pane if not provided', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%101');
      const hint = setHint('test-agent', room.id, 'Test hint message');

      expect(hint.pane_bootstrap).toBe('%101');
    });

    test('getHint returns pane-bootstrap hint before canonicalization', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%102');
      setHint('test-agent', room.id, 'Test hint message', { pane: '%102' });

      const hint = getHint('%102', null);
      expect(hint).toBeDefined();
      expect(hint!.agent_name).toBe('test-agent');
    });

    test('getHint returns session-bound hint after canonicalization', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%103');
      setHint('test-agent', room.id, 'Test hint message', { pane: '%103' });

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
      setHint('test-agent', room.id, 'Test hint message', { pane: '%104' });

      canonicalizeHintIdentity('test-agent', '%104', 'sess-456');
      canonicalizeHintIdentity('test-agent', '%104', 'sess-456'); // Second call

      const hint = getHint('%104', 'sess-456');
      expect(hint).toBeDefined();
      expect(hint!.session_id).toBe('sess-456');
    });

    test('canonicalizeHintIdentity retires stale session-bound row on Claude restart same pane', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%200');
      setHint('test-agent', room.id, 'Test hint message', { pane: '%200' });
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
      setHint('test-agent', room.id, 'Test hint message', { pane: '%105' });

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
      setHint('test-agent', room.id, 'Test hint message', { pane: '%106' });

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
      setHint('test-agent', room.id, 'Test hint message', { pane: '%107' });
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
      setHint('test-agent', room.id, 'Test hint message', { pane: '%108' });

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
      setHint('test-agent', room.id, 'Test hint message', { pane: '%110' });

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
      setHint('test-agent', room.id, 'Test hint message', { pane: '%111' });

      // Set again - should replace, not duplicate
      const hint2 = setHint('test-agent', room.id, 'Test hint message', {
        pane: '%111',
      });

      // Should only have one hint record
      const db = require('../src/state/db.ts').getDb();
      const count = db
        .prepare(
          'SELECT COUNT(*) as c FROM agent_hints WHERE agent_name = ? AND room_id = ?',
        )
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
      setHint('test-agent', room.id, 'Test hint message', { pane: '%112' });

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
      setHint('test-agent', room.id, 'Test hint message', { pane: '%113' });

      expect(tickHintCadence('%113', 'sess-missing').shouldShow).toBe(false);
      expect(tickHintCadence('%113', 'sess-missing').shouldShow).toBe(false);
      expect(tickHintCadence('%113', 'sess-missing').shouldShow).toBe(true);
    });

    test('removeAgent clears pane-bootstrap hints so a reused pane starts clean', () => {
      const room = mkRoom('test-room');
      addAgent('old-agent', 'worker', room.id, '%114');
      setHint('old-agent', room.id, 'Test hint message', { pane: '%114' });

      expect(removeAgent('old-agent', 'test-room')).toBe(true);
      expect(getHint('%114', null)).toBeNull();

      const recycledRoom = mkRoom('test-room');
      addAgent('new-agent', 'worker', recycledRoom.id, '%114');
      const hint = setHint('new-agent', recycledRoom.id, 'Test hint message', {
        pane: '%114',
      });
      expect(hint.agent_name).toBe('new-agent');
      expect(getHint('%114', null)?.agent_name).toBe('new-agent');
    });

    test('removeAgentFully clears hints across rooms for the removed agent', () => {
      const roomA = mkRoom('room-a');
      const roomB = mkRoom('room-b');
      addAgent('shared-agent', 'worker', roomA.id, '%115');
      addAgent('shared-agent', 'worker', roomB.id, '%116');
      setHint('shared-agent', roomA.id, 'Test hint message', { pane: '%115' });
      setHint('shared-agent', roomB.id, 'Test hint message', { pane: '%116' });

      removeAgentFully('shared-agent');

      expect(getHint('%115', null)).toBeNull();
      expect(getHint('%116', null)).toBeNull();
    });

    test('clearState clears hint and hook-event tables', () => {
      const room = mkRoom('test-room');
      addAgent('test-agent', 'worker', room.id, '%117');
      setHint('test-agent', room.id, 'Test hint message', { pane: '%117' });
      addHookEvent('test-agent', 'UserPromptSubmit', 'sess-clear', '{}');

      clearState();

      const db = require('../src/state/db.ts').getDb();
      const hintCount = db
        .query('SELECT COUNT(*) as c FROM agent_hints')
        .get() as { c: number };
      const hookEventCount = db
        .query('SELECT COUNT(*) as c FROM hook_events')
        .get() as { c: number };
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
      const hintA = setHint('multi-agent', roomA.id, 'Test hint message', {
        pane: '%200',
      });
      expect(hintA.agent_name).toBe('multi-agent');
      expect(hintA.room_id).toBe(roomA.id);

      const hintB = setHint('multi-agent', roomB.id, 'Test hint message', {
        pane: '%200',
      });
      expect(hintB.agent_name).toBe('multi-agent');
      expect(hintB.room_id).toBe(roomB.id);
    });

    test('BUG-2: canonicalizeHintIdentity works across rooms with shared pane', () => {
      const roomA = mkRoom('room-a2');
      const roomB = mkRoom('room-b2');
      addAgent('multi-agent2', 'worker', roomA.id, '%201');
      addAgent('multi-agent2', 'worker', roomB.id, '%201');

      setHint('multi-agent2', roomA.id, 'Test hint message', { pane: '%201' });
      setHint('multi-agent2', roomB.id, 'Test hint message', { pane: '%201' });

      // Canonicalize both — should not crash with UNIQUE constraint on session_id
      canonicalizeHintIdentity('multi-agent2', '%201', 'sess-shared-1');
      canonicalizeHintIdentity('multi-agent2', '%201', 'sess-shared-2');

      // Only one agent resolved via getAgentByPane — the other canonicalize returns
      // early because getAgentByPane returns one agent. But neither should crash.
    });

    test('BUG-3: getHint(pane, null) works after canonicalization', () => {
      const room = mkRoom('room-c3');
      addAgent('pane-agent', 'worker', room.id, '%202');
      setHint('pane-agent', room.id, 'Test hint message', { pane: '%202' });

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

      setHint('tick-agent', roomA.id, 'Test hint message', { pane: '%203' });
      setHint('tick-agent', roomB.id, 'Test hint message', { pane: '%204' });

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

    // ===== Custom message and cadence tests =====

    test('setHint stores custom message', () => {
      const room = mkRoom('msg-room');
      addAgent('msg-agent', 'worker', room.id, '%300');
      const hint = setHint(
        'msg-agent',
        room.id,
        'You are worker-1 in project-x.',
        { pane: '%300' },
      );
      expect(hint.message).toBe('You are worker-1 in project-x.');
      expect(hint.cadence).toBe(3); // default
    });

    test('setHint stores custom cadence', () => {
      const room = mkRoom('cadence-room');
      addAgent('cadence-agent', 'worker', room.id, '%301');
      const hint = setHint('cadence-agent', room.id, 'Every turn', {
        pane: '%301',
        cadence: 1,
      });
      expect(hint.cadence).toBe(1);
      expect(hint.message).toBe('Every turn');
    });

    test('setHint defaults cadence to 3', () => {
      const room = mkRoom('default-cadence');
      addAgent('dc-agent', 'worker', room.id, '%302');
      const hint = setHint('dc-agent', room.id, 'Default cadence', {
        pane: '%302',
      });
      expect(hint.cadence).toBe(3);
    });

    test('tickHintCadence respects cadence of 1 (every turn)', () => {
      const room = mkRoom('every-turn');
      addAgent('et-agent', 'worker', room.id, '%303');
      setHint('et-agent', room.id, 'Every single turn', {
        pane: '%303',
        cadence: 1,
      });

      const r1 = tickHintCadence('%303', null);
      expect(r1.shouldShow).toBe(true); // Turn 1: 1 % 1 === 0
      const r2 = tickHintCadence('%303', null);
      expect(r2.shouldShow).toBe(true); // Turn 2: 2 % 1 === 0
      expect(r2.hint?.message).toBe('Every single turn');
    });

    test('tickHintCadence respects cadence of 5', () => {
      const room = mkRoom('every-5');
      addAgent('e5-agent', 'worker', room.id, '%304');
      setHint('e5-agent', room.id, 'Every fifth turn', {
        pane: '%304',
        cadence: 5,
      });

      for (let i = 1; i <= 4; i++) {
        expect(tickHintCadence('%304', null).shouldShow).toBe(false);
      }
      const r5 = tickHintCadence('%304', null);
      expect(r5.shouldShow).toBe(true); // Turn 5: 5 % 5 === 0
      expect(r5.hint?.message).toBe('Every fifth turn');
    });

    test('custom message is returned in tickHintCadence result', () => {
      const room = mkRoom('msg-tick');
      addAgent('mt-agent', 'worker', room.id, '%305');
      setHint('mt-agent', room.id, 'Custom reminder text here', {
        pane: '%305',
      });

      tickHintCadence('%305', null);
      tickHintCadence('%305', null);
      const result = tickHintCadence('%305', null);
      expect(result.shouldShow).toBe(true);
      expect(result.hint?.message).toBe('Custom reminder text here');
    });
  });

  describe('worker notification dedup', () => {
    test('Stop hook skips when worker already sent completion this turn', () => {
      const room = mkRoom('dedup-test');
      addAgent('lead-1', 'leader', room.id, '%900');
      addAgent('w1', 'worker', room.id, '%901');

      // Simulate turn start (UserPromptSubmit)
      addHookEvent('w1', 'UserPromptSubmit', 's1', 'do the task');

      // Simulate Path 1: worker actively sent completion via crew send
      addMessage('lead-1', 'w1', 'dedup-test', 'Task done!', 'lead-1');

      // Simulate Path 2: Stop hook fires — should detect existing completion
      const payload = JSON.stringify({ last_assistant_message: 'Task done!' });
      addHookEvent('w1', 'Stop', 's1', payload);

      // Should be exactly 1 message from w1 (from Path 1), not 2
      const msgs = getRoomMessages('dedup-test');
      const fromW1 = msgs.filter((m: any) => m.from === 'w1');
      expect(fromW1.length).toBe(1);
    });

    test('Stop event records completion when worker did NOT actively send', () => {
      const room = mkRoom('no-dedup-test');
      addAgent('lead-2', 'leader', room.id, '%910');
      addAgent('w2', 'worker', room.id, '%911');

      // Turn start but no prior completion — worker didn't actively send
      addHookEvent('w2', 'UserPromptSubmit', 's2', 'do the work');

      const payload = JSON.stringify({
        last_assistant_message: 'Finished work!',
      });
      addHookEvent('w2', 'Stop', 's2', payload);

      const msgs = getRoomMessages('no-dedup-test');
      const completions = msgs.filter((m: any) => m.to === null);
      expect(completions.length).toBe(1);
      expect(completions[0].text).toContain('Finished work!');
    });

    test('Stop event without last_assistant_message still sends fallback completion', () => {
      const room = mkRoom('stop-empty-payload');
      addAgent('lead-empty', 'leader', room.id, '%912');
      addAgent('w-empty', 'worker', room.id, '%913');

      addHookEvent('w-empty', 'UserPromptSubmit', 's-empty', 'do minimal work');
      addHookEvent('w-empty', 'Stop', 's-empty', '{}');

      const completions = getRoomMessages('stop-empty-payload').filter(
        (m: any) => m.to === null,
      );
      expect(completions).toHaveLength(1);
      expect(completions[0]!.text).toBe('Task completed for session s-empty');
    });

    test('Stop hook stores FULL completion text even when response exceeds notifyMaxChars', () => {
      const room = mkRoom('stop-store-full-trunc');
      addAgent('lead-trunc', 'leader', room.id, '%920');
      addAgent('w-trunc', 'worker', room.id, '%921');

      addHookEvent('w-trunc', 'UserPromptSubmit', 's-trunc', 'do a long task');

      // Response longer than notifyMaxChars (default 5000) with a unique tail
      // marker past the cap. `crew read` must return the full text including
      // this tail — only the leader's pane preview should be capped.
      const longResponse = `${'x'.repeat(6000)}UNIQUE_TAIL_MARKER_PAST_5000`;
      expect(longResponse.length).toBeGreaterThan(5000);
      const payload = JSON.stringify({ last_assistant_message: longResponse });
      addHookEvent('w-trunc', 'Stop', 's-trunc', payload);

      const completions = getRoomMessages('stop-store-full-trunc').filter(
        (m: any) => m.to === null,
      );
      expect(completions.length).toBe(1);
      // Full text stored — tail marker survives the notifyMaxChars boundary
      expect(completions[0].text).toContain('UNIQUE_TAIL_MARKER_PAST_5000');
      expect(completions[0].text.length).toBe(longResponse.length);
    });

    test('Stop hook suppresses completion while worker goal is active and allows next Stop after goal done', async () => {
      const room = mkRoom('goal-gated-stop-done');
      addAgent('lead-4', 'leader', room.id, '%930');
      addAgent('w4', 'worker', room.id, '%931');
      setGoal('w4', room.id, 'Finish gated task', { pane: '%931' });

      addHookEvent('w4', 'UserPromptSubmit', 's4-active', 'do the gated work');
      addHookEvent(
        'w4',
        'Stop',
        's4-active',
        JSON.stringify({ last_assistant_message: 'Gated stop output' }),
      );

      expect(
        getRoomMessages('goal-gated-stop-done').filter(
          (m: any) => m.to === null,
        ),
      ).toHaveLength(0);

      expect(completeGoal('w4', room.id)).toBe(true);
      await Bun.sleep(1100);

      addHookEvent(
        'w4',
        'UserPromptSubmit',
        's4-done',
        'wrap up after goal done',
      );
      addHookEvent(
        'w4',
        'Stop',
        's4-done',
        JSON.stringify({ last_assistant_message: 'Delivered after goal done' }),
      );

      const completions = getRoomMessages('goal-gated-stop-done').filter(
        (m: any) => m.to === null,
      );
      expect(completions).toHaveLength(1);
      expect(completions[0].text).toContain('Delivered after goal done');

      addHookEvent(
        'w4',
        'Stop',
        's4-done',
        JSON.stringify({ last_assistant_message: 'Delivered after goal done' }),
      );
      expect(
        getRoomMessages('goal-gated-stop-done').filter(
          (m: any) => m.to === null,
        ),
      ).toHaveLength(1);
    });

    test('Stop hook allows next Stop after worker goal is unset', async () => {
      const room = mkRoom('goal-gated-stop-unset');
      addAgent('lead-5', 'leader', room.id, '%940');
      addAgent('w5', 'worker', room.id, '%941');
      setGoal('w5', room.id, 'Temporary gated task', { pane: '%941' });

      addHookEvent(
        'w5',
        'UserPromptSubmit',
        's5-active',
        'work while goal active',
      );
      addHookEvent(
        'w5',
        'Stop',
        's5-active',
        JSON.stringify({ last_assistant_message: 'Still gated output' }),
      );

      expect(
        getRoomMessages('goal-gated-stop-unset').filter(
          (m: any) => m.to === null,
        ),
      ).toHaveLength(0);

      expect(unsetGoal('w5', room.id)).toBe(true);
      await Bun.sleep(1100);

      addHookEvent('w5', 'UserPromptSubmit', 's5-unset', 'work after unset');
      addHookEvent(
        'w5',
        'Stop',
        's5-unset',
        JSON.stringify({ last_assistant_message: 'Delivered after unset' }),
      );

      const completions = getRoomMessages('goal-gated-stop-unset').filter(
        (m: any) => m.to === null,
      );
      expect(completions).toHaveLength(1);
      expect(completions[0].text).toContain('Delivered after unset');
    });

    test('Stop hook sends completion when previous turn completion exists but new turn started', async () => {
      const room = mkRoom('multi-turn-test');
      addAgent('lead-3', 'leader', room.id, '%920');
      addAgent('w3', 'worker', room.id, '%921');

      // Turn 1: worker sends completion
      addHookEvent('w3', 'UserPromptSubmit', 's1', 'task 1');
      addMessage('lead-3', 'w3', 'multi-turn-test', 'Done 1', 'lead-3');
      addHookEvent('w3', 'Stop', 's1', '{"last_assistant_message":"Done 1"}');

      // Wait 1s so Turn 2's UserPromptSubmit has a later timestamp
      await Bun.sleep(1100);

      // Turn 2: new prompt → old completion should NOT block new notification
      addHookEvent('w3', 'UserPromptSubmit', 's2', 'task 2');

      const payload = JSON.stringify({ last_assistant_message: 'Done 2' });
      addHookEvent('w3', 'Stop', 's2', payload);

      const msgs = getRoomMessages('multi-turn-test');
      const fromW3 = msgs.filter((m: any) => m.from === 'w3');
      expect(fromW3.length).toBe(2); // one from each turn
    });
  });
});
