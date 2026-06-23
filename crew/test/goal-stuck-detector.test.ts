import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  type GoalOutputEntry,
  goalMessageSimilarity,
  isGoalStuck,
  normalizeGoalMessage,
  STUCK_DEFAULTS,
} from '../src/state/goal-stuck.ts';
import {
  addAgent,
  clearGoalOutputs,
  clearState,
  getGoalByAgent,
  getOrCreateRoom,
  isGoalReminderPaused,
  pauseGoalReminder,
  recordAndEvaluateGoalStuck,
  setGoal,
  unpauseGoalReminder,
} from '../src/state/index.ts';

const T0 = 1_700_000_000_000;
const S = 6_000; // 6s between stops in a tight loop

function seq(msgs: string[], gapMs = S): GoalOutputEntry[] {
  return msgs.map((m, i) => ({ message: m, tsMs: T0 + i * gapMs }));
}

// --- pure detector ---

describe('normalizeGoalMessage', () => {
  test('strips turn counter + reminder echo', () => {
    const a =
      '🎯 Goal: Ship feature (turn 3)\n✅ crew:worker run bash command: crew goal done\nI am still working on it.';
    const b = 'I am still working on it.';
    expect(goalMessageSimilarity(a, b)).toBeGreaterThanOrEqual(0.9);
  });

  test('keeps meaningful wording differences distinct', () => {
    expect(
      goalMessageSimilarity('auth module wired up', 'auth module wired up'),
    ).toBe(1);
    expect(
      goalMessageSimilarity('auth module wired up', 'db migration applied'),
    ).toBeLessThan(0.5);
  });

  test('empty string normalizes to empty', () => {
    expect(normalizeGoalMessage('🎯 (turn 1) crew goal done')).toBe('');
  });
});

describe('isGoalStuck fixtures', () => {
  test('1. pure identical loop → STUCK', () => {
    expect(
      isGoalStuck(
        seq([
          'I am still working on it.',
          'I am still working on it.',
          'I am still working on it.',
        ]),
      ),
    ).toBe(true);
  });

  test('2. near-identical with noise (turn N, reminder echo, ts) → STUCK', () => {
    const base = 'I am still working on it.';
    const t1 = `${base} (turn 1) 🎯 Goal: ship (turn 1)\n✅ crew goal done`;
    const t2 = `${base} (turn 2) 12:04:05`;
    const t3 = `${base} (turn 3) 🎯 Goal: ship (turn 3)`;
    expect(isGoalStuck(seq([t1, t2, t3]))).toBe(true);
  });

  test('3. reminder-echo stripped, real content differs → NOT stuck', () => {
    const echo =
      '🎯 Goal: ship (turn N)\n✅ crew goal done\n📝 crew goal update';
    expect(
      isGoalStuck(
        seq([
          `${echo} Created src/auth.ts with login flow`,
          `${echo} Wrote migration for users table`,
          `${echo} Added unit tests for token refresh`,
        ]),
      ),
    ).toBe(false);
  });

  test('4. legit progress (diverse) → NOT stuck', () => {
    expect(
      isGoalStuck(
        seq([
          'Implemented the login endpoint',
          'Added validation for the request body',
          'Wrote integration tests and they pass',
        ]),
      ),
    ).toBe(false);
  });

  test('5. similar content but wide time gaps → NOT stuck', () => {
    const m = 'Status: still working on auth.';
    expect(
      isGoalStuck([
        { message: m, tsMs: T0 },
        { message: m, tsMs: T0 + 3_600_000 },
        { message: m, tsMs: T0 + 7_200_000 },
      ]),
    ).toBe(false);
  });

  test('6. empty payloads (no signal) → NOT stuck (no false positive)', () => {
    // Empty carries no content; cannot conclude looping. Prevents false trips
    // on minimal/leader fixtures and genuinely message-less stops.
    expect(isGoalStuck(seq(['', '', '']))).toBe(false);
  });

  test('7. window resets on a divergent turn → NOT stuck', () => {
    expect(
      isGoalStuck(
        seq([
          'I am still working on it.',
          'I am still working on it.',
          'Actually finished the endpoint, pushing tests now.',
        ]),
      ),
    ).toBe(false);
  });

  test('8. boundary: window-1 → NOT stuck; window → STUCK', () => {
    const m = 'I am still working on it.';
    expect(isGoalStuck(seq([m, m]))).toBe(false);
    expect(isGoalStuck(seq([m, m, m]))).toBe(true);
  });

  test('9. window=5 needs 5 consecutive', () => {
    const o5 = { ...STUCK_DEFAULTS, window: 5 };
    const m = 'I am still working on it.';
    expect(isGoalStuck(seq([m, m, m, m], S), o5)).toBe(false);
    expect(isGoalStuck(seq([m, m, m, m, m], S), o5)).toBe(true);
  });

  test('10. one large gap breaks rhythm → NOT stuck', () => {
    const m = 'I am still working on it.';
    expect(
      isGoalStuck([
        { message: m, tsMs: T0 },
        { message: m, tsMs: T0 + 6_000 },
        { message: m, tsMs: T0 + 6_000 + 300_000 },
      ]),
    ).toBe(false);
  });
});

// --- DB-backed integration ---

describe('goal stuck-detector state (DB)', () => {
  beforeEach(() => initDb(':memory:'));
  afterEach(() => closeDb());

  function setup() {
    clearState();
    const room = getOrCreateRoom('/test/stuck', 'stuck-room');
    addAgent('worker-1', 'worker', room.id, '%200');
    const goal = setGoal('worker-1', room.id, 'Ship feature', { pane: '%200' });
    return { room, goal };
  }

  test('3 identical tight outputs trip stuck + pause', () => {
    const { goal } = setup();
    const m = 'I am still working on it.';

    expect(isGoalReminderPaused(goal.id)).toBe(false);
    let r = recordAndEvaluateGoalStuck(goal.id, m, T0);
    expect(r.stuck).toBe(false);
    r = recordAndEvaluateGoalStuck(goal.id, m, T0 + S);
    expect(r.stuck).toBe(false);
    r = recordAndEvaluateGoalStuck(goal.id, m, T0 + S * 2);
    expect(r.stuck).toBe(true);

    expect(pauseGoalReminder(goal.id)).toBe(true); // trip
    expect(isGoalReminderPaused(goal.id)).toBe(true);
    expect(pauseGoalReminder(goal.id)).toBe(false); // already paused → no-op
  });

  test('diverse outputs never trip stuck', () => {
    const { goal } = setup();
    recordAndEvaluateGoalStuck(goal.id, 'Implemented login endpoint', T0);
    recordAndEvaluateGoalStuck(goal.id, 'Added request validation', T0 + S);
    const r = recordAndEvaluateGoalStuck(
      goal.id,
      'Wrote integration tests',
      T0 + S * 2,
    );
    expect(r.stuck).toBe(false);
    expect(isGoalReminderPaused(goal.id)).toBe(false);
  });

  test('clearGoalOutputs + unpause resets on goal update', () => {
    const { goal } = setup();
    const m = 'I am still working on it.';
    recordAndEvaluateGoalStuck(goal.id, m, T0);
    recordAndEvaluateGoalStuck(goal.id, m, T0 + S);
    recordAndEvaluateGoalStuck(goal.id, m, T0 + S * 2);
    pauseGoalReminder(goal.id);
    expect(isGoalReminderPaused(goal.id)).toBe(true);

    // Simulate `crew goal update` reset.
    clearGoalOutputs(goal.id);
    unpauseGoalReminder(goal.id);
    expect(isGoalReminderPaused(goal.id)).toBe(false);

    // After reset, a fresh identical pair is not yet stuck (window resets).
    const r = recordAndEvaluateGoalStuck(goal.id, m, T0 + S * 10);
    expect(r.stuck).toBe(false);
  });

  test('reminder_paused surfaces on GoalRecord', () => {
    const { goal } = setup();
    pauseGoalReminder(goal.id);
    const reloaded = getGoalByAgent('worker-1', goal.room_id);
    expect(reloaded?.reminder_paused).toBe(1);
  });
});
