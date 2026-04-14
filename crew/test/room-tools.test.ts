import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { initDb, closeDb } from '../src/state/db.ts';
import { handleCreateRoom } from '../src/tools/create-room.ts';
import { handleDeleteRoom } from '../src/tools/delete-room.ts';
import { addAgent, getRoom, getAllRooms, getAgent } from '../src/state/index.ts';

describe('create-room tool', () => {
  beforeEach(() => { initDb(':memory:'); });
  afterEach(() => { closeDb(); });

  test('creates a room with valid name', () => {
    const result = handleCreateRoom({ room: 'alpha', name: 'boss-1' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.room).toBe('alpha');
    expect(data.topic).toBeNull();
    expect(data.created_at).toBeDefined();
  });

  test('creates a room with topic', () => {
    const result = handleCreateRoom({ room: 'beta', topic: 'planning', name: 'boss-1' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.topic).toBe('planning');
  });

  test('room row exists in state after creation', () => {
    handleCreateRoom({ room: 'gamma', name: 'boss-1' });
    expect(getRoom('gamma')).toBeDefined();
  });

  test('rejects duplicate room name', () => {
    handleCreateRoom({ room: 'dup', name: 'boss-1' });
    const result = handleCreateRoom({ room: 'dup', name: 'boss-1' });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text);
    expect(data.error).toMatch(/already exists/);
  });

  test('rejects room name with spaces', () => {
    const result = handleCreateRoom({ room: 'bad name', name: 'boss-1' });
    expect(result.isError).toBe(true);
  });

  test('rejects room name over 32 chars', () => {
    const result = handleCreateRoom({ room: 'a'.repeat(33), name: 'boss-1' });
    expect(result.isError).toBe(true);
  });

  test('rejects missing room param', () => {
    const result = handleCreateRoom({ room: '', name: 'boss-1' });
    expect(result.isError).toBe(true);
  });
});

describe('delete-room tool', () => {
  beforeEach(() => { initDb(':memory:'); });
  afterEach(() => { closeDb(); });

  test('refuses without --confirm', () => {
    handleCreateRoom({ room: 'target', name: 'boss-1' });
    const result = handleDeleteRoom({ room: 'target', name: 'boss-1' });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]!.text);
    expect(data.error).toMatch(/--confirm/);
  });

  test('deletes empty room with --confirm', () => {
    handleCreateRoom({ room: 'empty-room', name: 'boss-1' });
    const result = handleDeleteRoom({ room: 'empty-room', confirm: true, name: 'boss-1' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.deleted).toBe(true);
    expect(data.removed_members).toEqual([]);
    expect(getRoom('empty-room')).toBeUndefined();
  });

  test('reports members and messages deleted', () => {
    // Create room via addAgent (which also creates the room + membership)
    addAgent('wk', 'worker', 'crew-room', '%10');
    const result = handleDeleteRoom({ room: 'crew-room', confirm: true, name: 'boss-1' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.removed_members).toContain('wk');
    expect(getRoom('crew-room')).toBeUndefined();
  });

  test('cleans up agent with no remaining rooms', () => {
    addAgent('solo-wk', 'worker', 'solo-room', '%20');
    expect(getAgent('solo-wk')).toBeDefined();
    handleDeleteRoom({ room: 'solo-room', confirm: true, name: 'boss-1' });
    expect(getAgent('solo-wk')).toBeUndefined();
  });

  test('preserves agent that belongs to another room', () => {
    addAgent('shared-wk', 'worker', 'room-a', '%30');
    addAgent('shared-wk', 'worker', 'room-b', '%30');
    handleDeleteRoom({ room: 'room-a', confirm: true, name: 'boss-1' });
    expect(getAgent('shared-wk')).toBeDefined();
  });

  test('errors on non-existent room', () => {
    const result = handleDeleteRoom({ room: 'ghost', confirm: true, name: 'boss-1' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).error).toMatch(/does not exist/);
  });
});
