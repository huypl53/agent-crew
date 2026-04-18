import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { initDb, closeDb } from '../src/state/db.ts';
import { addAgent, clearState, getOrCreateRoom } from '../src/state/index.ts';
import { assertRole } from '../src/shared/role-guard.ts';

function mkRoom(name: string) {
  return getOrCreateRoom(`/test/${name}`, name);
}

describe('assertRole', () => {
  beforeEach(() => {
    initDb(':memory:');
    clearState();
    addAgent('lead-1', 'leader', mkRoom('frontend').id, '%1');
    addAgent('worker-1', 'worker', mkRoom('frontend').id, '%2');
    addAgent('boss-1', 'boss', mkRoom('company').id, '%3');
  });

  afterAll(() => { closeDb(); });

  test('allows leader for leader-allowed action', () => {
    const agent = assertRole('lead-1', ['leader', 'boss'], 'interrupt_worker');
    expect(agent.name).toBe('lead-1');
    expect(agent.role).toBe('leader');
  });

  test('allows boss for leader/boss-allowed action', () => {
    const agent = assertRole('boss-1', ['leader', 'boss'], 'interrupt_worker');
    expect(agent.name).toBe('boss-1');
  });

  test('rejects worker for leader-only action', () => {
    expect(() => assertRole('worker-1', ['leader', 'boss'], 'interrupt_worker'))
      .toThrow('Only leader/boss can interrupt_worker');
  });

  test('rejects unknown agent', () => {
    expect(() => assertRole('nobody', ['leader', 'boss'], 'interrupt_worker'))
      .toThrow('not registered');
  });

  test('allows worker for worker-allowed action', () => {
    const agent = assertRole('worker-1', ['worker'], 'update_task');
    expect(agent.name).toBe('worker-1');
  });
});
