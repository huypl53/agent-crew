import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  addAgent,
  addMessage,
  getOrCreateRoom,
  readRoomMessages,
} from '../src/state/index.ts';

function mkRoom(name: string) {
  return getOrCreateRoom(`/test/${name}`, name);
}

/**
 * Broadcast visibility for `readRoomMessages` must mirror the push path
 * (delivery/index.ts `flushPushQueueForAgent`): a worker's broadcast (the
 * stop-hook completion) is leader-audience only, while a leader's broadcast is
 * a room announcement everyone sees. These tests pin each branch so the two
 * read paths cannot diverge again.
 */
describe('readRoomMessages broadcast visibility', () => {
  beforeEach(() => initDb(':memory:'));
  afterEach(() => closeDb());

  test('leader reads a worker broadcast completion', () => {
    const room = mkRoom('r');
    addAgent('leader-1', 'leader', room.id, '%10');
    addAgent('worker-1', 'worker', room.id, '%11');

    addMessage('r', 'worker-1', 'r', 'completion report', null);

    const { messages } = readRoomMessages('leader-1', 'r');
    expect(messages.map((m) => m.text)).toContain('completion report');
  });

  test('worker does NOT read a peer worker broadcast', () => {
    const room = mkRoom('r');
    addAgent('leader-1', 'leader', room.id, '%10');
    addAgent('worker-1', 'worker', room.id, '%11');
    addAgent('worker-2', 'worker', room.id, '%12');

    addMessage('r', 'worker-1', 'r', 'peer completion', null);

    const { messages } = readRoomMessages('worker-2', 'r');
    expect(messages.map((m) => m.text)).not.toContain('peer completion');
  });

  test('worker does NOT read its own broadcast (no self-echo)', () => {
    const room = mkRoom('r');
    addAgent('worker-1', 'worker', room.id, '%11');

    addMessage('r', 'worker-1', 'r', 'my completion', null);

    const { messages } = readRoomMessages('worker-1', 'r');
    expect(messages).toHaveLength(0);
  });

  test('worker reads a leader broadcast (room announcement)', () => {
    const room = mkRoom('r');
    addAgent('leader-1', 'leader', room.id, '%10');
    addAgent('worker-1', 'worker', room.id, '%11');

    addMessage('r', 'leader-1', 'r', 'everyone do X', null);

    const { messages } = readRoomMessages('worker-1', 'r');
    expect(messages.map((m) => m.text)).toContain('everyone do X');
  });

  test('directed message still delivered regardless of role', () => {
    const room = mkRoom('r');
    addAgent('leader-1', 'leader', room.id, '%10');
    addAgent('worker-1', 'worker', room.id, '%11');

    addMessage('worker-1', 'leader-1', 'r', 'hey leader', 'worker-1');

    const { messages } = readRoomMessages('worker-1', 'r');
    expect(messages.map((m) => m.text)).toContain('hey leader');
  });
});
