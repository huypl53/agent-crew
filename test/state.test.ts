import { describe, expect, test, beforeEach } from 'bun:test';
import {
  addAgent, getAgent, removeAgent, getRoom, getAllRooms,
  getRoomMembers, isNameTakenInRoom, addMessage, readMessages,
  clearState,
} from '../src/state/index.ts';

describe('state module', () => {
  beforeEach(() => {
    clearState();
  });

  describe('agents', () => {
    test('adds and retrieves an agent', () => {
      const agent = addAgent('boss', 'boss', 'company', '%100');
      expect(agent.name).toBe('boss');
      expect(agent.role).toBe('boss');
      expect(agent.rooms).toEqual(['company']);
      expect(getAgent('boss')).toBeDefined();
    });

    test('agent joins multiple rooms', () => {
      addAgent('lead-1', 'leader', 'company', '%101');
      addAgent('lead-1', 'leader', 'frontend', '%101');
      const agent = getAgent('lead-1');
      expect(agent?.rooms).toEqual(['company', 'frontend']);
    });

    test('removes agent from room', () => {
      addAgent('worker-1', 'worker', 'frontend', '%102');
      removeAgent('worker-1', 'frontend');
      expect(getAgent('worker-1')).toBeUndefined();
    });

    test('agent with multiple rooms: removing one keeps others', () => {
      addAgent('lead-1', 'leader', 'company', '%101');
      addAgent('lead-1', 'leader', 'frontend', '%101');
      removeAgent('lead-1', 'frontend');
      const agent = getAgent('lead-1');
      expect(agent?.rooms).toEqual(['company']);
    });
  });

  describe('rooms', () => {
    test('creates room on first agent join', () => {
      addAgent('boss', 'boss', 'company', '%100');
      const room = getRoom('company');
      expect(room).toBeDefined();
      expect(room!.members).toEqual(['boss']);
    });

    test('room tracks all members', () => {
      addAgent('boss', 'boss', 'company', '%100');
      addAgent('lead-1', 'leader', 'company', '%101');
      const room = getRoom('company');
      expect(room!.members).toEqual(['boss', 'lead-1']);
    });

    test('room is deleted when last member leaves', () => {
      addAgent('worker-1', 'worker', 'temp', '%102');
      removeAgent('worker-1', 'temp');
      expect(getRoom('temp')).toBeUndefined();
    });

    test('getAllRooms returns all rooms', () => {
      addAgent('boss', 'boss', 'company', '%100');
      addAgent('worker-1', 'worker', 'frontend', '%102');
      expect(getAllRooms().length).toBe(2);
    });

    test('getRoomMembers returns agents', () => {
      addAgent('boss', 'boss', 'company', '%100');
      addAgent('lead-1', 'leader', 'company', '%101');
      const members = getRoomMembers('company');
      expect(members.length).toBe(2);
      expect(members.map(m => m.name)).toEqual(['boss', 'lead-1']);
    });

    test('isNameTakenInRoom detects duplicates', () => {
      addAgent('boss', 'boss', 'company', '%100');
      expect(isNameTakenInRoom('boss', 'company')).toBe(true);
      expect(isNameTakenInRoom('boss', 'frontend')).toBe(false);
      expect(isNameTakenInRoom('nobody', 'company')).toBe(false);
    });
  });

  describe('messages', () => {
    test('adds and reads messages', () => {
      addAgent('sender', 'leader', 'room', '%100');
      addAgent('receiver', 'worker', 'room', '%101');

      addMessage('receiver', 'sender', 'room', 'hello', 'push', 'receiver');
      addMessage('receiver', 'sender', 'room', 'world', 'push', 'receiver');

      const result = readMessages('receiver');
      expect(result.messages.length).toBe(2);
      expect(result.messages[0]!.text).toBe('hello');
      expect(result.messages[1]!.text).toBe('world');
    });

    test('cursor-based reading with since_sequence', () => {
      addAgent('a', 'worker', 'r', '%100');
      addMessage('a', 'b', 'r', 'msg1', 'push', null);
      addMessage('a', 'b', 'r', 'msg2', 'push', null);

      const first = readMessages('a');
      expect(first.messages.length).toBe(2);

      addMessage('a', 'b', 'r', 'msg3', 'push', null);
      const second = readMessages('a', undefined, first.next_sequence);
      expect(second.messages.length).toBe(1);
      expect(second.messages[0]!.text).toBe('msg3');
    });

    test('filters by room', () => {
      addAgent('a', 'worker', 'room1', '%100');
      addMessage('a', 'b', 'room1', 'hello', 'push', null);
      addMessage('a', 'b', 'room2', 'world', 'push', null);

      const result = readMessages('a', 'room1');
      expect(result.messages.length).toBe(1);
      expect(result.messages[0]!.room).toBe('room1');
    });
  });
});
