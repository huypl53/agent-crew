import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDb } from '../src/state/db.ts';
import { clearState, getAgent } from '../src/state/index.ts';
import { handleJoinRoom } from '../src/tools/join-room.ts';

describe('pull-only join', () => {
  beforeEach(() => {
    initDb(':memory:');
    // Unset tmux env vars so the pull-only path triggers
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
  });

  afterEach(() => {
    closeDb();
  });

  test('registers agent with null pane when no tmux env', async () => {
    const result = await handleJoinRoom({
      room: 'test-room',
      role: 'worker',
      name: 'pull-agent',
    });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.name).toBe('pull-agent');
    expect(data.pull_only).toBe(true);
    expect(data.tmux_target).toBeNull();
  });

  test('prefixes role for auto-generated name', async () => {
    const result = await handleJoinRoom({
      room: 'test-room',
      role: 'worker',
    });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.name).toMatch(/^worker-agent-[a-z0-9]{4}$/);
  });

  test('agent row has null pane in state', async () => {
    await handleJoinRoom({
      room: 'test-room',
      role: 'worker',
      name: 'pull-bot',
    });
    const agent = getAgent('pull-bot');
    expect(agent).toBeDefined();
    expect(agent!.tmux_target).toBeNull();
  });

  test('pull-only join tracks latest room registration', async () => {
    await handleJoinRoom({
      room: 'room-a',
      role: 'worker',
      name: 'pull-multi',
    });
    await handleJoinRoom({
      room: 'room-b',
      role: 'worker',
      name: 'pull-multi',
    });
    const agent = getAgent('pull-multi');
    expect(agent?.room_name).toBe('room-b');
    expect(agent?.tmux_target).toBeNull();
  });

  test('explicit tmux_target overrides pull-only path', async () => {
    // If tmux_target is provided, we try pane validation — this will fail with an invalid pane
    // but the key check is: no-pane path is not taken
    const result = await handleJoinRoom({
      room: 'test-room',
      role: 'worker',
      name: 'explicit-agent',
      tmux_target: '%99999', // non-existent pane
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text);
    expect(data.error).toMatch(/does not exist/);
  });
});
