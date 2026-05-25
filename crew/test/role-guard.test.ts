import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { assertRole } from '../src/shared/role-guard.ts';
import { closeDb, initDb } from '../src/state/db.ts';
import { addAgent, clearState, getOrCreateRoom } from '../src/state/index.ts';

function mkRoom(name: string) {
  return getOrCreateRoom(`/test/${name}`, name);
}

describe('assertRole', () => {
  beforeEach(() => {
    initDb(':memory:');
    clearState();
    addAgent('lead-1', 'leader', mkRoom('frontend').id, '%1');
    addAgent('worker-1', 'worker', mkRoom('frontend').id, '%2');
    addAgent('leader-1', 'leader', mkRoom('company').id, '%3');
  });

  afterAll(() => {
    closeDb();
  });

  test('allows leader for leader-allowed action', () => {
    const agent = assertRole('lead-1', ['leader', 'leader'], 'interrupt_worker');
    expect(agent.name).toBe('lead-1');
    expect(agent.role).toBe('leader');
  });

  test('allows leader for leader/leader-allowed action', () => {
    const agent = assertRole('leader-1', ['leader', 'leader'], 'interrupt_worker');
    expect(agent.name).toBe('leader-1');
  });

  test('rejects worker for leader-only action', () => {
    expect(() =>
      assertRole('worker-1', ['leader', 'leader'], 'interrupt_worker'),
    ).toThrow('Only leader/leader can interrupt_worker');
  });

  test('rejects unknown agent', () => {
    expect(() =>
      assertRole('nobody', ['leader', 'leader'], 'interrupt_worker'),
    ).toThrow('not registered');
  });

  test('allows worker for worker-allowed action', () => {
    const agent = assertRole('worker-1', ['worker'], 'update_task');
    expect(agent.name).toBe('worker-1');
  });
});
