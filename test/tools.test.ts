import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { handleJoinRoom } from '../src/tools/join-room.ts';
import { handleLeaveRoom } from '../src/tools/leave-room.ts';
import { handleListRooms } from '../src/tools/list-rooms.ts';
import { handleListMembers } from '../src/tools/list-members.ts';
import { handleReadMessages } from '../src/tools/read-messages.ts';
import { handleSendMessage } from '../src/tools/send-message.ts';
import { clearState } from '../src/state/index.ts';
import { createTestSession, destroyTestSession, cleanupAllTestSessions } from './helpers.ts';

let testPaneA: string;
let testPaneB: string;
const SESSION_A = 'tools-a';
const SESSION_B = 'tools-b';

describe('MCP tools', () => {
  beforeEach(async () => {
    clearState();
    const a = await createTestSession(SESSION_A);
    const b = await createTestSession(SESSION_B);
    testPaneA = a.pane;
    testPaneB = b.pane;
  });

  afterAll(async () => {
    await cleanupAllTestSessions();
  });

  describe('join_room', () => {
    test('registers agent with valid params', async () => {
      const result = await handleJoinRoom({
        room: 'company',
        role: 'boss',
        name: 'boss-1',
        tmux_target: testPaneA,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]!.text);
      expect(data.name).toBe('boss-1');
      expect(data.role).toBe('boss');
      expect(data.room).toBe('company');
    });

    test('rejects duplicate name in same room', async () => {
      await handleJoinRoom({ room: 'company', role: 'boss', name: 'boss-1', tmux_target: testPaneA });
      const result = await handleJoinRoom({ room: 'company', role: 'worker', name: 'boss-1', tmux_target: testPaneB });
      expect(result.isError).toBe(true);
    });

    test('allows same agent in multiple rooms', async () => {
      await handleJoinRoom({ room: 'company', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      const result = await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      expect(result.isError).toBeUndefined();
    });

    test('rejects invalid role', async () => {
      const result = await handleJoinRoom({ room: 'r', role: 'admin', name: 'n', tmux_target: testPaneA });
      expect(result.isError).toBe(true);
    });

    test('rejects non-existent pane', async () => {
      const result = await handleJoinRoom({ room: 'r', role: 'worker', name: 'n', tmux_target: '%99999' });
      expect(result.isError).toBe(true);
    });
  });

  describe('leave_room', () => {
    test('removes agent from room', async () => {
      await handleJoinRoom({ room: 'company', role: 'boss', name: 'boss-1', tmux_target: testPaneA });
      const result = await handleLeaveRoom({ room: 'company', name: 'boss-1' });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.success).toBe(true);
    });

    test('errors when not in room', async () => {
      await handleJoinRoom({ room: 'company', role: 'boss', name: 'boss-1', tmux_target: testPaneA });
      const result = await handleLeaveRoom({ room: 'frontend', name: 'boss-1' });
      expect(result.isError).toBe(true);
    });
  });

  describe('list_rooms', () => {
    test('lists all rooms with counts', async () => {
      await handleJoinRoom({ room: 'company', role: 'boss', name: 'boss-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'company', role: 'leader', name: 'lead-1', tmux_target: testPaneB });
      const result = await handleListRooms();
      const data = JSON.parse(result.content[0]!.text);
      expect(data.rooms.length).toBe(1);
      expect(data.rooms[0].name).toBe('company');
      expect(data.rooms[0].member_count).toBe(2);
      expect(data.rooms[0].roles.boss).toBe(1);
      expect(data.rooms[0].roles.leader).toBe(1);
    });
  });

  describe('list_members', () => {
    test('lists members of a room', async () => {
      await handleJoinRoom({ room: 'company', role: 'boss', name: 'boss-1', tmux_target: testPaneA });
      const result = await handleListMembers({ room: 'company' });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.members.length).toBe(1);
      expect(data.members[0].name).toBe('boss-1');
    });

    test('errors for non-existent room', async () => {
      const result = await handleListMembers({ room: 'nope' });
      expect(result.isError).toBe(true);
    });
  });

  describe('messaging', () => {
    test('send and read directed push message', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const sendResult = await handleSendMessage({
        room: 'frontend',
        text: 'Build the login page',
        to: 'builder-1',
        name: 'lead-1',
      });
      const sendData = JSON.parse(sendResult.content[0]!.text);
      expect(sendData.queued).toBe(true);
      expect(sendData.delivered).toBe(true);

      const readResult = await handleReadMessages({ name: 'builder-1' });
      const readData = JSON.parse(readResult.content[0]!.text);
      expect(readData.messages.length).toBe(1);
      expect(readData.messages[0].text).toBe('Build the login page');
      expect(readData.messages[0].from).toBe('lead-1');
    });

    test('pull message is queued but not delivered', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const result = await handleSendMessage({
        room: 'frontend',
        text: 'Task complete',
        to: 'lead-1',
        name: 'builder-1',
        mode: 'pull',
      });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.queued).toBe(true);
      expect(data.delivered).toBe(false);
    });

    test('broadcast message reaches all members except sender', async () => {
      await handleJoinRoom({ room: 'team', role: 'leader', name: 'lead', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'team', role: 'worker', name: 'w1', tmux_target: testPaneB });

      await handleSendMessage({ room: 'team', text: 'Stand by', name: 'lead' });

      const readW1 = await handleReadMessages({ name: 'w1' });
      const w1Data = JSON.parse(readW1.content[0]!.text);
      expect(w1Data.messages.length).toBe(1);

      // Sender should NOT receive their own broadcast
      const readLead = await handleReadMessages({ name: 'lead' });
      const leadData = JSON.parse(readLead.content[0]!.text);
      expect(leadData.messages.length).toBe(0);
    });

    test('cursor-based read_messages', async () => {
      await handleJoinRoom({ room: 'r', role: 'worker', name: 'a', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'r', role: 'leader', name: 'b', tmux_target: testPaneB });

      await handleSendMessage({ room: 'r', text: 'msg1', to: 'a', name: 'b' });
      await handleSendMessage({ room: 'r', text: 'msg2', to: 'a', name: 'b' });

      const first = await handleReadMessages({ name: 'a' });
      const firstData = JSON.parse(first.content[0]!.text);
      expect(firstData.messages.length).toBe(2);

      await handleSendMessage({ room: 'r', text: 'msg3', to: 'a', name: 'b' });

      const second = await handleReadMessages({ name: 'a', since_sequence: firstData.next_sequence });
      const secondData = JSON.parse(second.content[0]!.text);
      expect(secondData.messages.length).toBe(1);
      expect(secondData.messages[0].text).toBe('msg3');
    });

    test('room-filtered read_messages', async () => {
      await handleJoinRoom({ room: 'r1', role: 'worker', name: 'a', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'r1', role: 'leader', name: 'b', tmux_target: testPaneB });
      await handleJoinRoom({ room: 'r2', role: 'worker', name: 'a', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'r2', role: 'leader', name: 'b', tmux_target: testPaneB });

      await handleSendMessage({ room: 'r1', text: 'hello r1', to: 'a', name: 'b' });
      await handleSendMessage({ room: 'r2', text: 'hello r2', to: 'a', name: 'b' });

      const result = await handleReadMessages({ name: 'a', room: 'r1' });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.messages.length).toBe(1);
      expect(data.messages[0].room).toBe('r1');
    });
  });
});
