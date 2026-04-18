import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { initDb, closeDb } from '../src/state/db.ts';
import { addAgent, addMessage, getAgentDbStatus, getOrCreateRoom } from '../src/state/index.ts';

function mkRoom(name: string) {
  return getOrCreateRoom(`/test/${name}`, name);
}

describe('event-driven status', () => {
  beforeEach(() => {
    initDb(':memory:');
    // leader and worker registered in the same room
    addAgent('leader', 'leader', mkRoom('test-room').id, '%10');
    addAgent('worker', 'worker', mkRoom('test-room').id, '%11');
  });

  afterEach(() => {
    closeDb();
  });

  test('task message to worker sets worker status = busy', () => {
    expect(getAgentDbStatus('worker')).toBeNull(); // starts unknown
    addMessage('%11', 'leader', 'test-room', 'do the thing', 'push', 'worker', 'task');
    expect(getAgentDbStatus('worker')).toBe('busy');
  });

  test('completion message from worker sets worker status = idle', () => {
    addMessage('%11', 'leader', 'test-room', 'do the thing', 'push', 'worker', 'task');
    expect(getAgentDbStatus('worker')).toBe('busy');
    addMessage('%10', 'worker', 'test-room', 'done', 'pull', 'leader', 'completion');
    expect(getAgentDbStatus('worker')).toBe('idle');
  });

  test('error message from worker sets worker status = idle', () => {
    addMessage('%11', 'leader', 'test-room', 'do the thing', 'push', 'worker', 'task');
    addMessage('%10', 'worker', 'test-room', 'blew up', 'pull', 'leader', 'error');
    expect(getAgentDbStatus('worker')).toBe('idle');
  });

  test('question message from worker sets worker status = idle', () => {
    addMessage('%11', 'leader', 'test-room', 'do the thing', 'push', 'worker', 'task');
    addMessage('%10', 'worker', 'test-room', 'what do I do?', 'pull', 'leader', 'question');
    expect(getAgentDbStatus('worker')).toBe('idle');
  });

  test('note message from worker sets worker status = idle', () => {
    addMessage('%11', 'leader', 'test-room', 'do the thing', 'push', 'worker', 'task');
    addMessage('%10', 'worker', 'test-room', 'FYI...', 'pull', 'leader', 'note');
    expect(getAgentDbStatus('worker')).toBe('idle');
  });

  test('note message from leader to worker does not change status', () => {
    // leader sends a note to worker — not a task, not a completion-class msg from worker
    addMessage('%11', 'leader', 'test-room', 'heads up', 'push', 'worker', 'note');
    // leader's status should not be set to idle (it was never set)
    expect(getAgentDbStatus('leader')).toBe('idle'); // note from leader sets leader idle
    // worker should not be busy (note ≠ task)
    expect(getAgentDbStatus('worker')).toBeNull();
  });

  test('chat message does not change any status', () => {
    addMessage('%11', 'leader', 'test-room', 'hey', 'push', 'worker', 'chat');
    expect(getAgentDbStatus('leader')).toBeNull();
    expect(getAgentDbStatus('worker')).toBeNull();
  });

  test('multiple rapid messages: final status reflects last message', () => {
    // task → worker busy, then completion → worker idle, then another task → busy again
    addMessage('%11', 'leader', 'test-room', 'task 1', 'push', 'worker', 'task');
    expect(getAgentDbStatus('worker')).toBe('busy');
    addMessage('%10', 'worker', 'test-room', 'done 1', 'pull', 'leader', 'completion');
    expect(getAgentDbStatus('worker')).toBe('idle');
    addMessage('%11', 'leader', 'test-room', 'task 2', 'push', 'worker', 'task');
    expect(getAgentDbStatus('worker')).toBe('busy');
    addMessage('%10', 'worker', 'test-room', 'done 2', 'pull', 'leader', 'completion');
    expect(getAgentDbStatus('worker')).toBe('idle');
  });
});
