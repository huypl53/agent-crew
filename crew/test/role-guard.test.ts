import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  assertAgentCanInspectWorker,
  assertRole,
} from '../src/shared/role-guard.ts';
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
    const agent = assertRole(
      'lead-1',
      ['leader', 'leader'],
      'interrupt_worker',
    );
    expect(agent.name).toBe('lead-1');
    expect(agent.role).toBe('leader');
  });

  test('allows leader for leader/leader-allowed action', () => {
    const agent = assertRole(
      'leader-1',
      ['leader', 'leader'],
      'interrupt_worker',
    );
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

  test('inspection rejects non-leader caller', () => {
    expect(() =>
      assertAgentCanInspectWorker('worker-1', 'frontend', 'worker-1'),
    ).toThrow('Only leaders can inspect workers');
  });

  test('inspection rejects cross-room leader access', () => {
    expect(() =>
      assertAgentCanInspectWorker('worker-1', 'frontend', 'leader-1'),
    ).toThrow('must be a member of room "frontend"');
  });

  test('inspection returns caller and worker for same-room leader', () => {
    const result = assertAgentCanInspectWorker(
      'worker-1',
      'frontend',
      'lead-1',
    );
    expect(result.caller.name).toBe('lead-1');
    expect(result.worker.name).toBe('worker-1');
  });

  test('inspection allows leader registered in multiple rooms to inspect within requested room', () => {
    addAgent('lead-1', 'leader', mkRoom('company').id, '%1');

    const result = assertAgentCanInspectWorker(
      'worker-1',
      'frontend',
      'lead-1',
    );

    expect(result.caller.room_name).toBe('frontend');
    expect(result.worker.room_name).toBe('frontend');
  });
});
