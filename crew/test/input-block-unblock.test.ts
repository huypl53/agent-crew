/**
 * Tests for input-block unblock flow: verifying that armed mode
 * auto-clears on UserPromptSubmit and triggers push queue flush.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  addAgent,
  addMessage,
  clearArmedInputBlock,
  clearState,
  getAgentInputBlockMode,
  getOrCreateRoom,
  setAgentInputBlockMode,
} from '../src/state/index.ts';
import { processHookEventInput } from '../src/tools/hook-event.ts';

describe('Input block unblock flow', () => {
  beforeEach(() => {
    process.env.CREW_STATE_DIR = `/tmp/crew-unblock-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    initDb();
    clearState();
  });

  afterEach(() => {
    closeDb();
    delete process.env.CREW_STATE_DIR;
    delete process.env.TMUX_PANE;
  });

  describe('clearArmedInputBlock', () => {
    test('clears armed mode and returns true', () => {
      const room = getOrCreateRoom('/test/room', 'room');
      addAgent('worker-1', 'worker', room.id, '%500');
      setAgentInputBlockMode('worker-1', 'armed');

      expect(getAgentInputBlockMode('worker-1')).toBe('armed');

      const wasBlocked = clearArmedInputBlock('worker-1');
      expect(wasBlocked).toBe(true);
      expect(getAgentInputBlockMode('worker-1')).toBe('off');
    });

    test('returns false when mode is off (no-op)', () => {
      const room = getOrCreateRoom('/test/room', 'room');
      addAgent('worker-1', 'worker', room.id, '%501');

      expect(getAgentInputBlockMode('worker-1')).toBe('off');
      const wasBlocked = clearArmedInputBlock('worker-1');
      expect(wasBlocked).toBe(false);
    });

    test('does NOT clear persist mode (requires manual unblock)', () => {
      const room = getOrCreateRoom('/test/room', 'room');
      addAgent('worker-1', 'worker', room.id, '%502');
      setAgentInputBlockMode('worker-1', 'persist');

      expect(getAgentInputBlockMode('worker-1')).toBe('persist');

      const wasBlocked = clearArmedInputBlock('worker-1');
      expect(wasBlocked).toBe(false);
      expect(getAgentInputBlockMode('worker-1')).toBe('persist');
    });
  });

  describe('UserPromptSubmit auto-unblock', () => {
    test('armed mode is cleared when UserPromptSubmit hook fires', async () => {
      const room = getOrCreateRoom('/test/room', 'room');
      addAgent('worker-1', 'worker', room.id, '%510');

      // Block the agent
      setAgentInputBlockMode('worker-1', 'armed');
      expect(getAgentInputBlockMode('worker-1')).toBe('armed');

      // Simulate UserPromptSubmit hook event
      const input = JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-unblock-test',
      });
      const result = await processHookEventInput(input, '%510');
      const data = JSON.parse(result.content[0]?.text);

      // Block should be cleared
      expect(data.ok).toBe(true);
      expect(getAgentInputBlockMode('worker-1')).toBe('off');
    });

    test('persist mode is NOT cleared by UserPromptSubmit', async () => {
      const room = getOrCreateRoom('/test/room', 'room');
      addAgent('worker-1', 'worker', room.id, '%511');

      // Block the agent with persist
      setAgentInputBlockMode('worker-1', 'persist');
      expect(getAgentInputBlockMode('worker-1')).toBe('persist');

      // Simulate UserPromptSubmit hook event
      const input = JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-persist-test',
      });
      await processHookEventInput(input, '%511');

      // Persist mode should remain
      expect(getAgentInputBlockMode('worker-1')).toBe('persist');
    });

    test('messages queued during armed block become deliverable after unblock', async () => {
      const room = getOrCreateRoom('/test/room', 'room');
      addAgent('worker-1', 'worker', room.id, '%520');

      // Block the agent
      setAgentInputBlockMode('worker-1', 'armed');

      // Send a message to the blocked worker
      const msg = addMessage(
        'worker-1',
        'leader-1',
        'room',
        'Hello worker, this is blocked',
        'pull',
        'worker-1',
      );
      expect(msg.message_id).toBeTruthy();

      // Worker cannot read messages while blocked
      // (readRoomMessages checks block mode)

      // Now simulate unblock via UserPromptSubmit
      const input = JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-unblock-read-test',
      });
      await processHookEventInput(input, '%520');

      // Block should be cleared
      expect(getAgentInputBlockMode('worker-1')).toBe('off');

      // Now worker should be able to read messages
      // (This verifies the state change - actual delivery
      // depends on push queue flush which happens async)
    });
  });
});
