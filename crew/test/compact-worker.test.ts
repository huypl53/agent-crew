import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { resolve } from 'node:path';

const queueModulePath = resolve(import.meta.dir, '../src/delivery/pane-queue.ts');
type QueuedCommand = { type: 'command'; text: string };

const queued: QueuedCommand[] = [];

mock.module(queueModulePath, () => ({
  getQueue: () => ({
    enqueue: async (item: QueuedCommand) => {
      queued.push(item);
    },
  }),
}));

import { addAgent, closeDb, getOrCreateRoom, initDb } from '../src/state/index.ts';
import { handleCompactWorker } from '../src/tools/compact-worker.ts';

function parseResult(result: { content?: Array<{ text?: string }> }): any {
  const text = result.content?.[0]?.text ?? '{}';
  return JSON.parse(text);
}

describe('compact_worker', () => {
  beforeEach(() => {
    queued.length = 0;
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  test('ignores message for codex workers and sends only /compact', async () => {
    const room = getOrCreateRoom('/test/compact-codex', 'compact');
    addAgent('lead', 'leader', room.id, '%1', 'claude-code');
    addAgent('wk-01', 'worker', room.id, '%2', 'codex');

    const result = await handleCompactWorker({
      worker_name: 'wk-01',
      room: 'compact',
      name: 'lead',
      message: 'summarize current task progress',
    });

    expect(result.isError).toBeUndefined();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toEqual({ type: 'command', text: '/compact' });
    expect(parseResult(result).message).toContain('Sent "/compact" to wk-01');
  });

  test('keeps message for Claude workers in /compact', async () => {
    const room = getOrCreateRoom('/test/compact-claude', 'compact');
    addAgent('lead', 'leader', room.id, '%1', 'claude-code');
    addAgent('wk-01', 'worker', room.id, '%2', 'claude-code');

    const result = await handleCompactWorker({
      worker_name: 'wk-01',
      room: 'compact',
      name: 'lead',
      message: 'summarize current task progress',
    });

    expect(result.isError).toBeUndefined();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toEqual({
      type: 'command',
      text: '/compact summarize current task progress',
    });
    expect(parseResult(result).message).toContain(
      'Sent "/compact summarize current task progress"',
    );
  });
});
