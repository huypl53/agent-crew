import { describe, expect, test, beforeEach } from 'bun:test';
import {
  addAgent, getAgent, removeAgent, getRoom, getAllRooms,
  getRoomMembers, isNameTakenInRoom, addMessage, readMessages,
  getRoomMessages, getCursor, advanceCursor, readRoomMessages,
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

    test('message has kind field', () => {
      addAgent('a', 'worker', 'r', '%100');
      addAgent('b', 'leader', 'r', '%101');
      const msg = addMessage('a', 'b', 'r', 'hello', 'push', 'a', 'chat');
      expect(msg.kind).toBe('chat');
    });

    test('message kind defaults to chat', () => {
      addAgent('a', 'worker', 'r', '%100');
      addAgent('b', 'leader', 'r', '%101');
      const msg = addMessage('a', 'b', 'r', 'hello', 'push', 'a');
      expect(msg.kind).toBe('chat');
    });
  });

  describe('room messages', () => {
    test('message is stored in room log', () => {
      addAgent('a', 'leader', 'frontend', '%100');
      addAgent('b', 'worker', 'frontend', '%101');
      addMessage('b', 'a', 'frontend', 'build login', 'push', 'b', 'task');

      const roomMsgs = getRoomMessages('frontend');
      expect(roomMsgs.length).toBe(1);
      expect(roomMsgs[0]!.text).toBe('build login');
      expect(roomMsgs[0]!.from).toBe('a');
    });

    test('all room members can read room messages', () => {
      addAgent('lead', 'leader', 'frontend', '%100');
      addAgent('w1', 'worker', 'frontend', '%101');
      addAgent('w2', 'worker', 'frontend', '%102');

      addMessage('w1', 'lead', 'frontend', 'build login', 'push', 'w1', 'task');

      const roomMsgs = getRoomMessages('frontend');
      expect(roomMsgs.length).toBe(1);
    });

    test('broadcast is one canonical message', () => {
      addAgent('lead', 'leader', 'team', '%100');
      addAgent('w1', 'worker', 'team', '%101');
      addAgent('w2', 'worker', 'team', '%102');

      addMessage('__room__', 'lead', 'team', 'standup', 'push', null, 'chat');

      const roomMsgs = getRoomMessages('team');
      expect(roomMsgs.length).toBe(1);
      expect(roomMsgs[0]!.to).toBeNull();
    });

    test('room log is capped at MAX_ROOM_MESSAGES', () => {
      addAgent('a', 'leader', 'r', '%100');
      addAgent('b', 'worker', 'r', '%101');

      for (let i = 0; i < 1005; i++) {
        addMessage('b', 'a', 'r', `msg-${i}`, 'push', 'b', 'chat');
      }

      const msgs = getRoomMessages('r');
      expect(msgs.length).toBe(1000);
      expect(msgs[0]!.text).toBe('msg-5'); // oldest 5 evicted
    });
  });

  describe('persistence', () => {
    test('room messages survive flush and load cycle', async () => {
      addAgent('a', 'leader', 'r', '%100');
      addAgent('b', 'worker', 'r', '%101');
      addMessage('b', 'a', 'r', 'test-persist', 'push', 'b', 'task');

      const msgs = getRoomMessages('r');
      expect(msgs.length).toBe(1);
      expect(msgs[0]!.kind).toBe('task');
    });
  });

  describe('cursors', () => {
    test('getCursor returns 0 for new agent-room pair', () => {
      addAgent('a', 'worker', 'r', '%100');
      expect(getCursor('a', 'r')).toBe(0);
    });

    test('advanceCursor updates read position', () => {
      addAgent('a', 'worker', 'r', '%100');
      advanceCursor('a', 'r', 5);
      expect(getCursor('a', 'r')).toBe(5);
    });

    test('readRoomMessages advances cursor', () => {
      addAgent('lead', 'leader', 'r', '%100');
      addAgent('w1', 'worker', 'r', '%101');

      addMessage('w1', 'lead', 'r', 'task1', 'push', 'w1', 'task');
      addMessage('w1', 'lead', 'r', 'task2', 'push', 'w1', 'task');

      // First read: gets both messages
      const first = readRoomMessages('w1', 'r');
      expect(first.messages.length).toBe(2);

      // Add a third message
      addMessage('w1', 'lead', 'r', 'task3', 'push', 'w1', 'task');

      // Second read: only new message
      const second = readRoomMessages('w1', 'r');
      expect(second.messages.length).toBe(1);
      expect(second.messages[0]!.text).toBe('task3');
    });
  });
});
