import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  addAgent,
  addPartyResponse,
  closeDb,
  endParty,
  getOrCreateRoom,
  getPartyResponses,
  getPartyState,
  getPendingPartyWorkers,
  initDb,
  isPartyRoundComplete,
  nextPartyRound,
  skipPartyWorker,
  startParty,
} from '../src/state/index.ts';

describe('Party Mode', () => {
  let roomId: number;

  beforeEach(() => {
    initDb(':memory:');
    const room = getOrCreateRoom('/test', 'test-room');
    roomId = room.id;
    addAgent('leader-1', 'leader', roomId, '%100');
    addAgent('worker-a', 'worker', roomId, '%101');
    addAgent('worker-b', 'worker', roomId, '%102');
    addAgent('worker-c', 'worker', roomId, '%103');
  });

  afterEach(() => {
    closeDb();
  });

  describe('Party State', () => {
    test('startParty sets active state', () => {
      startParty(roomId, 'Test topic');
      const state = getPartyState(roomId);
      expect(state?.active).toBe(true);
      expect(state?.round).toBe(1);
      expect(state?.topic).toBe('Test topic');
      expect(state?.started_at).toBeTruthy();
    });

    test('nextPartyRound increments round', () => {
      startParty(roomId, 'Topic 1');
      const newRound = nextPartyRound(roomId, 'Topic 2');
      expect(newRound).toBe(2);
      const state = getPartyState(roomId);
      expect(state?.round).toBe(2);
      expect(state?.topic).toBe('Topic 2');
    });

    test('endParty clears active state', () => {
      startParty(roomId, 'Test topic');
      endParty(roomId);
      const state = getPartyState(roomId);
      expect(state?.active).toBe(false);
    });

    test('endParty clears party responses', () => {
      startParty(roomId, 'Test topic');
      addPartyResponse(roomId, 1, 'worker-a', 'Response', null);
      endParty(roomId);
      const responses = getPartyResponses(roomId, 1);
      expect(responses.length).toBe(0);
    });

    test('getPartyState returns null for non-existent room', () => {
      const state = getPartyState(9999);
      expect(state).toBeNull();
    });
  });

  describe('Party Responses', () => {
    beforeEach(() => {
      startParty(roomId, 'Test topic');
    });

    test('addPartyResponse stores response', () => {
      addPartyResponse(roomId, 1, 'worker-a', 'My response', null);
      const responses = getPartyResponses(roomId, 1);
      expect(responses.length).toBe(1);
      expect(responses[0].agent_name).toBe('worker-a');
      expect(responses[0].response).toBe('My response');
    });

    test('addPartyResponse stores hook event id when null', () => {
      addPartyResponse(roomId, 1, 'worker-a', 'My response', null);
      const responses = getPartyResponses(roomId, 1);
      expect(responses[0].hook_event_id).toBeNull();
    });

    test('addPartyResponse upserts on duplicate', () => {
      addPartyResponse(roomId, 1, 'worker-a', 'First response', null);
      addPartyResponse(roomId, 1, 'worker-a', 'Updated response', null);
      const responses = getPartyResponses(roomId, 1);
      expect(responses.length).toBe(1);
      expect(responses[0].response).toBe('Updated response');
    });

    test('getPartyResponses returns empty for non-existent round', () => {
      const responses = getPartyResponses(roomId, 99);
      expect(responses.length).toBe(0);
    });

    test('getPendingPartyWorkers returns workers without response', () => {
      addPartyResponse(roomId, 1, 'worker-a', 'Response A', null);
      const pending = getPendingPartyWorkers(roomId, 1);
      expect(pending).toContain('worker-b');
      expect(pending).toContain('worker-c');
      expect(pending).not.toContain('worker-a');
    });

    test('getPendingPartyWorkers returns all workers initially', () => {
      const pending = getPendingPartyWorkers(roomId, 1);
      expect(pending.length).toBe(3);
      expect(pending).toContain('worker-a');
      expect(pending).toContain('worker-b');
      expect(pending).toContain('worker-c');
    });

    test('isPartyRoundComplete returns false initially', () => {
      expect(isPartyRoundComplete(roomId, 1)).toBe(false);
    });

    test('isPartyRoundComplete returns true when all responded', () => {
      addPartyResponse(roomId, 1, 'worker-a', 'A', null);
      addPartyResponse(roomId, 1, 'worker-b', 'B', null);
      addPartyResponse(roomId, 1, 'worker-c', 'C', null);
      expect(isPartyRoundComplete(roomId, 1)).toBe(true);
    });

    test('skipPartyWorker marks worker as skipped', () => {
      skipPartyWorker(roomId, 1, 'worker-a');
      const responses = getPartyResponses(roomId, 1);
      expect(responses.length).toBe(1);
      expect(responses[0].response).toBe('[SKIPPED]');
      expect(getPendingPartyWorkers(roomId, 1)).not.toContain('worker-a');
    });

    test('skipPartyWorker contributes to round completion', () => {
      skipPartyWorker(roomId, 1, 'worker-a');
      addPartyResponse(roomId, 1, 'worker-b', 'B', null);
      addPartyResponse(roomId, 1, 'worker-c', 'C', null);
      expect(isPartyRoundComplete(roomId, 1)).toBe(true);
    });
  });

  describe('Multi-round Party', () => {
    test('responses are tracked per round', () => {
      startParty(roomId, 'Round 1 topic');
      addPartyResponse(roomId, 1, 'worker-a', 'R1 response', null);

      nextPartyRound(roomId, 'Round 2 topic');
      addPartyResponse(roomId, 2, 'worker-a', 'R2 response', null);

      const r1Responses = getPartyResponses(roomId, 1);
      const r2Responses = getPartyResponses(roomId, 2);

      expect(r1Responses.length).toBe(1);
      expect(r1Responses[0].response).toBe('R1 response');
      expect(r2Responses.length).toBe(1);
      expect(r2Responses[0].response).toBe('R2 response');
    });

    test('pending workers reset each round', () => {
      startParty(roomId, 'Round 1');
      addPartyResponse(roomId, 1, 'worker-a', 'R1', null);
      addPartyResponse(roomId, 1, 'worker-b', 'R1', null);
      addPartyResponse(roomId, 1, 'worker-c', 'R1', null);
      expect(isPartyRoundComplete(roomId, 1)).toBe(true);

      nextPartyRound(roomId, 'Round 2');
      expect(isPartyRoundComplete(roomId, 2)).toBe(false);
      expect(getPendingPartyWorkers(roomId, 2).length).toBe(3);
    });
  });
});
