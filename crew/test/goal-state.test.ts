import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  addAgent,
  canonicalizeGoalIdentity,
  clearState,
  completeGoal,
  getGoal,
  getGoalByAgent,
  getOrCreateRoom,
  setGoal,
  tickGoalTurnCount,
  unsetGoal,
  updateGoalDescription,
} from '../src/state/index.ts';

function mkRoom(name: string) {
  return getOrCreateRoom(`/test/${name}`, name);
}

describe('goal tracking', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  describe('setGoal', () => {
    test('creates a goal with pane-bootstrap', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%100');

      const goal = setGoal('worker-1', room.id, 'Implement auth module', { pane: '%100' });

      expect(goal.agent_name).toBe('worker-1');
      expect(goal.description).toBe('Implement auth module');
      expect(goal.pane_bootstrap).toBe('%100');
      expect(goal.session_id).toBeNull();
      expect(goal.status).toBe('active');
      expect(goal.turn_count).toBe(0);
      expect(goal.set_by).toBe('self');
    });

    test('uses agent pane when not provided', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%101');

      const goal = setGoal('worker-1', room.id, 'Fix bug');

      expect(goal.pane_bootstrap).toBe('%101');
    });

    test('setBy defaults to self', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%102');

      const goal = setGoal('worker-1', room.id, 'Task', { pane: '%102' });

      expect(goal.set_by).toBe('self');
    });

    test('setBy can be overridden (e.g. leader setting for worker)', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%103');

      const goal = setGoal('worker-1', room.id, 'Task', { pane: '%103', setBy: 'leader-1' });

      expect(goal.set_by).toBe('leader-1');
    });

    test('replaces existing goal (DELETE+INSERT)', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%104');

      setGoal('worker-1', room.id, 'First goal', { pane: '%104' });
      const goal = setGoal('worker-1', room.id, 'Second goal', { pane: '%104' });

      expect(goal.description).toBe('Second goal');

      // Only one goal for this agent
      const lookup = getGoalByAgent('worker-1', room.id);
      expect(lookup).not.toBeNull();
      expect(lookup!.description).toBe('Second goal');
    });

    test('throws if agent not found', () => {
      clearState();
      const room = mkRoom('room-1');

      expect(() => setGoal('ghost', room.id, 'Task', { pane: '%999' })).toThrow(
        'Agent not found',
      );
    });
  });

  describe('getGoal', () => {
    test('returns null when no goal exists', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%200');

      expect(getGoal('%200', null)).toBeNull();
    });

    test('looks up by pane-bootstrap', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%201');
      setGoal('worker-1', room.id, 'Pane goal', { pane: '%201' });

      const goal = getGoal('%201', null);
      expect(goal).not.toBeNull();
      expect(goal!.description).toBe('Pane goal');
    });

    test('looks up by session_id (no pane fallback)', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%202');
      setGoal('worker-1', room.id, 'Session goal', { pane: '%202' });
      canonicalizeGoalIdentity('worker-1', '%202', 'sess-1');

      // Session lookup works
      expect(getGoal(null, 'sess-1')).not.toBeNull();

      // Session path does NOT fall through to pane — same as getHint
      expect(getGoal(null, 'sess-nonexistent')).toBeNull();
    });

    test('scopes by room_id when provided', () => {
      clearState();
      const room1 = mkRoom('room-1');
      const room2 = mkRoom('room-2');
      addAgent('worker-1', 'worker', room1.id, '%203');
      addAgent('worker-1', 'worker', room2.id, '%204');

      setGoal('worker-1', room1.id, 'Room 1 goal', { pane: '%203' });
      setGoal('worker-1', room2.id, 'Room 2 goal', { pane: '%204' });

      expect(getGoal('%203', null, room1.id)!.description).toBe('Room 1 goal');
      expect(getGoal('%203', null, room2.id)).toBeNull();
    });
  });

  describe('getGoalByAgent', () => {
    test('returns goal by agent name + room', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%210');
      setGoal('worker-1', room.id, 'Agent goal', { pane: '%210' });

      const goal = getGoalByAgent('worker-1', room.id);
      expect(goal).not.toBeNull();
      expect(goal!.description).toBe('Agent goal');
    });

    test('returns null when no goal', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%211');

      expect(getGoalByAgent('worker-1', room.id)).toBeNull();
    });
  });

  describe('completeGoal', () => {
    test('marks active goal as done', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%220');
      setGoal('worker-1', room.id, 'Finish feature', { pane: '%220' });

      const done = completeGoal('worker-1', room.id);
      expect(done).toBe(true);

      const goal = getGoalByAgent('worker-1', room.id);
      expect(goal!.status).toBe('done');
      expect(goal!.completed_at).not.toBeNull();
    });

    test('returns false when no active goal', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%221');

      expect(completeGoal('worker-1', room.id)).toBe(false);
    });

    test('idempotent on already-done goal', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%222');
      setGoal('worker-1', room.id, 'Done already', { pane: '%222' });

      completeGoal('worker-1', room.id);
      const second = completeGoal('worker-1', room.id);
      expect(second).toBe(false);
    });
  });

  describe('updateGoalDescription', () => {
    test('updates description of active goal', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%230');
      setGoal('worker-1', room.id, 'Old description', { pane: '%230' });

      const updated = updateGoalDescription('worker-1', room.id, 'New description');
      expect(updated).toBe(true);

      expect(getGoalByAgent('worker-1', room.id)!.description).toBe('New description');
    });

    test('returns false when no active goal', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%231');

      expect(updateGoalDescription('worker-1', room.id, 'Nope')).toBe(false);
    });
  });

  describe('unsetGoal', () => {
    test('removes goal', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%240');
      setGoal('worker-1', room.id, 'Remove me', { pane: '%240' });

      expect(unsetGoal('worker-1', room.id)).toBe(true);
      expect(getGoalByAgent('worker-1', room.id)).toBeNull();
    });

    test('returns false when no goal exists', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%241');

      expect(unsetGoal('worker-1', room.id)).toBe(false);
    });
  });

  describe('canonicalizeGoalIdentity', () => {
    test('migrates pane-bootstrap to session_id', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%300');
      setGoal('worker-1', room.id, 'Migrate me', { pane: '%300' });

      canonicalizeGoalIdentity('worker-1', '%300', 'sess-300');

      const goal = getGoal(null, 'sess-300');
      expect(goal).not.toBeNull();
      expect(goal!.session_id).toBe('sess-300');
      expect(goal!.pane_bootstrap).toBe('%300');
    });

    test('is idempotent', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%301');
      setGoal('worker-1', room.id, 'Idempotent', { pane: '%301' });

      canonicalizeGoalIdentity('worker-1', '%301', 'sess-301');
      canonicalizeGoalIdentity('worker-1', '%301', 'sess-301');

      const goal = getGoal(null, 'sess-301');
      expect(goal!.session_id).toBe('sess-301');
    });

    test('handles pane reuse across sessions (S1→S2)', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%302');
      setGoal('worker-1', room.id, 'Restart test', { pane: '%302' });

      // First session
      canonicalizeGoalIdentity('worker-1', '%302', 'S1');
      expect(getGoal(null, 'S1')).not.toBeNull();

      // Restart — new session on same pane
      canonicalizeGoalIdentity('worker-1', '%302', 'S2');
      expect(getGoal(null, 'S1')).toBeNull();
      expect(getGoal(null, 'S2')?.session_id).toBe('S2');
    });

    test('no-ops when no goal exists', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%303');

      // Should not throw
      canonicalizeGoalIdentity('worker-1', '%303', 'sess-303');
    });

    test('no-ops when agent name mismatches pane', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%304');
      setGoal('worker-1', room.id, 'Wrong agent', { pane: '%304' });

      canonicalizeGoalIdentity('wrong-agent', '%304', 'sess-304');

      // Goal should remain unchanged (no session_id set)
      const goal = getGoal('%304', null);
      expect(goal).not.toBeNull();
      expect(goal!.session_id).toBeNull();
    });
  });

  describe('tickGoalTurnCount', () => {
    test('increments turn count and returns updated goal', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%400');
      setGoal('worker-1', room.id, 'Count turns', { pane: '%400' });

      const g1 = tickGoalTurnCount('%400', null, room.id);
      expect(g1).not.toBeNull();
      expect(g1!.turn_count).toBe(1);

      const g2 = tickGoalTurnCount('%400', null, room.id);
      expect(g2!.turn_count).toBe(2);
    });

    test('returns null when no goal exists', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%401');

      expect(tickGoalTurnCount('%401', null, room.id)).toBeNull();
    });

    test('does NOT increment done/abandoned goals', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%402');
      setGoal('worker-1', room.id, 'Done goal', { pane: '%402' });

      // Complete it
      completeGoal('worker-1', room.id);

      // Tick should return null — status filter excludes done
      expect(tickGoalTurnCount('%402', null, room.id)).toBeNull();
    });

    test('works with session-based goals via COALESCE', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%403');
      setGoal('worker-1', room.id, 'Session tick', { pane: '%403' });
      canonicalizeGoalIdentity('worker-1', '%403', 'sess-403');

      const g = tickGoalTurnCount('%403', 'sess-403', room.id);
      expect(g).not.toBeNull();
      expect(g!.turn_count).toBe(1);
    });

    test('falls back from session to pane in COALESCE', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%404');
      setGoal('worker-1', room.id, 'Pane fallback', { pane: '%404' });

      // Session doesn't exist yet — should find pane_bootstrap row
      const g = tickGoalTurnCount('%404', 'unknown-session', room.id);
      expect(g).not.toBeNull();
      expect(g!.turn_count).toBe(1);
    });
  });

  describe('clearState cleans up goals', () => {
    test('clearState removes all goal records', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%500');
      setGoal('worker-1', room.id, 'Will be cleared', { pane: '%500' });

      clearState();

      // Re-add agent + room so getGoalByAgent can query
      const room2 = mkRoom('room-1');
      addAgent('worker-1', 'worker', room2.id, '%500');
      expect(getGoalByAgent('worker-1', room2.id)).toBeNull();
    });
  });
});
