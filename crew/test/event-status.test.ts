import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  resetIdleTransition,
  resetSweepIdleTracking,
  shouldNotifyIdleTransition,
} from '../src/server/sweep.ts';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  addAgent,
  getOrCreateRoom,
} from '../src/state/index.ts';

function mkRoom(name: string) {
  return getOrCreateRoom(`/test/${name}`, name);
}

describe('event-driven status', () => {
  beforeEach(() => {
    initDb(':memory:');
    addAgent('leader', 'leader', mkRoom('test-room').id, '%10');
    addAgent('worker', 'worker', mkRoom('test-room').id, '%11');
  });

  afterEach(() => {
    closeDb();
  });

  test('idle transition notify emits once per epoch and resets on activity', () => {
    resetSweepIdleTracking();

    expect(shouldNotifyIdleTransition('worker')).toBe(true);
    expect(shouldNotifyIdleTransition('worker')).toBe(false);
    expect(shouldNotifyIdleTransition('worker')).toBe(false);

    resetIdleTransition('worker');

    expect(shouldNotifyIdleTransition('worker')).toBe(true);
    expect(shouldNotifyIdleTransition('worker')).toBe(false);
  });
});
