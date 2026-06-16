import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  addAgent,
  completeGoal,
  getGoalByAgent,
  getOrCreateRoom,
  setGoal,
} from '../src/state/index.ts';
import { MockHook } from './lib/mock-hook.ts';
import { _tapLog } from './lib/fixture-runner.ts';

describe('hook goal reminder race conditions', () => {
  beforeEach(() => {
    _tapLog.length = 0;
    initDb(':memory:');
  });

  afterEach(() => {
    _tapLog.length = 0;
    closeDb();
  });

  test.serial('Stop reminder callback does not send when goal is done before delay elapses', async () => {
    const room = getOrCreateRoom('/tmp/goal-reminder-race', 'goal-reminder-race');
    const pane = '%42';
    addAgent('w1', 'worker', room.id, pane);
    setGoal('w1', room.id, 'Fix login bug', { pane });

    const preStepLogLen = _tapLog.length;
    const hook = new MockHook({ pane, sessionId: 'sess-race' });

    const first = hook.fire('Stop');
    await Bun.sleep(60);
    expect(completeGoal('w1', room.id)).toBe(true);

    await first;
    await Bun.sleep(1700);

    const stepLog = _tapLog.slice(preStepLogLen);
    const reminders = stepLog.filter((entry) => entry.op === 'sendKeys' && entry.target === pane);

    expect(getGoalByAgent('w1', room.id)?.status).toBe('done');
    expect(reminders).toHaveLength(0);
  });
});

