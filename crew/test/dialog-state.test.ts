import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  addAgent,
  clearState,
  createLeaderDialog,
  getActiveDialogForWorker,
  getDialogById,
  getOrCreateRoom,
  listPendingDialogs,
  markDialogAnswered,
} from '../src/state/index.ts';
import type { DialogQuestion } from '../src/shared/types.ts';

function mkRoom(name: string) {
  return getOrCreateRoom(`/test/${name}`, name);
}

const Q_COLOR: DialogQuestion[] = [
  {
    question: 'Which color?',
    header: 'Color',
    multiSelect: false,
    options: [
      { label: 'Red' },
      { label: 'Green', description: 'eco' },
      { label: 'Blue' },
    ],
  },
];

describe('leader dialog state', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  describe('createLeaderDialog', () => {
    test('records a pending ask_question dialog', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%100');

      const d = createLeaderDialog({
        roomId: room.id,
        workerName: 'worker-1',
        workerPane: '%100',
        leaderName: 'leader-1',
        dialogType: 'ask_question',
        toolName: 'AskUserQuestion',
        sessionId: 'sess-1',
        questions: Q_COLOR,
        sourceHookEventId: null,
      });

      expect(d.id).toBeGreaterThan(0);
      expect(d.room_id).toBe(room.id);
      expect(d.worker_name).toBe('worker-1');
      expect(d.worker_pane).toBe('%100');
      expect(d.leader_name).toBe('leader-1');
      expect(d.dialog_type).toBe('ask_question');
      expect(d.tool_name).toBe('AskUserQuestion');
      expect(d.session_id).toBe('sess-1');
      expect(d.status).toBe('pending');
      expect(d.answer).toBeNull();
      expect(d.answered_at).toBeNull();
      expect(d.questions?.[0].options.map((o) => o.label)).toEqual([
        'Red',
        'Green',
        'Blue',
      ]);
    });

    test('records a plan_approval dialog', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%100');

      const d = createLeaderDialog({
        roomId: room.id,
        workerName: 'worker-1',
        workerPane: '%100',
        leaderName: null,
        dialogType: 'plan_approval',
        toolName: 'ExitPlanMode',
        sessionId: null,
        questions: null,
        sourceHookEventId: null,
      });

      expect(d.dialog_type).toBe('plan_approval');
      expect(d.questions).toBeNull();
    });

    test('expires prior pending dialog for same worker/room', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%100');

      const first = createLeaderDialog({
        roomId: room.id,
        workerName: 'worker-1',
        workerPane: '%100',
        leaderName: null,
        dialogType: 'ask_question',
        toolName: 'AskUserQuestion',
        sessionId: null,
        questions: Q_COLOR,
        sourceHookEventId: null,
      });
      const second = createLeaderDialog({
        roomId: room.id,
        workerName: 'worker-1',
        workerPane: '%100',
        leaderName: null,
        dialogType: 'ask_question',
        toolName: 'AskUserQuestion',
        sessionId: null,
        questions: Q_COLOR,
        sourceHookEventId: null,
      });

      expect(getDialogById(first.id)?.status).toBe('expired');
      expect(getDialogById(second.id)?.status).toBe('pending');
      // Only one active per worker
      expect(getActiveDialogForWorker('worker-1', room.id)?.id).toBe(second.id);
    });
  });

  describe('getActiveDialogForWorker', () => {
    test('returns null when none pending', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%100');
      expect(getActiveDialogForWorker('worker-1', room.id)).toBeNull();
    });

    test('does not return answered dialogs', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%100');

      const d = createLeaderDialog({
        roomId: room.id,
        workerName: 'worker-1',
        workerPane: '%100',
        leaderName: null,
        dialogType: 'plan_approval',
        toolName: 'ExitPlanMode',
        sessionId: null,
        questions: null,
        sourceHookEventId: null,
      });
      markDialogAnswered(d.id, { type: 'plan_approval', approved: true });

      expect(getActiveDialogForWorker('worker-1', room.id)).toBeNull();
    });

    test('scopes by room', () => {
      clearState();
      const roomA = mkRoom('room-a');
      const roomB = mkRoom('room-b');
      addAgent('worker-1', 'worker', roomA.id, '%101');
      addAgent('worker-1', 'worker', roomB.id, '%102');

      createLeaderDialog({
        roomId: roomA.id,
        workerName: 'worker-1',
        workerPane: '%101',
        leaderName: null,
        dialogType: 'ask_question',
        toolName: 'AskUserQuestion',
        sessionId: null,
        questions: Q_COLOR,
        sourceHookEventId: null,
      });

      expect(getActiveDialogForWorker('worker-1', roomA.id)).not.toBeNull();
      expect(getActiveDialogForWorker('worker-1', roomB.id)).toBeNull();
    });
  });

  describe('listPendingDialogs', () => {
    test('lists pending across workers, scoped by room', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%110');
      addAgent('worker-2', 'worker', room.id, '%111');

      createLeaderDialog({
        roomId: room.id,
        workerName: 'worker-1',
        workerPane: '%110',
        leaderName: null,
        dialogType: 'ask_question',
        toolName: 'AskUserQuestion',
        sessionId: null,
        questions: Q_COLOR,
        sourceHookEventId: null,
      });
      createLeaderDialog({
        roomId: room.id,
        workerName: 'worker-2',
        workerPane: '%111',
        leaderName: null,
        dialogType: 'plan_approval',
        toolName: 'ExitPlanMode',
        sessionId: null,
        questions: null,
        sourceHookEventId: null,
      });

      const pending = listPendingDialogs(room.id);
      expect(pending).toHaveLength(2);
      expect(pending.map((d) => d.worker_name).sort()).toEqual([
        'worker-1',
        'worker-2',
      ]);
    });

    test('excludes answered and expired', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%110');

      const d = createLeaderDialog({
        roomId: room.id,
        workerName: 'worker-1',
        workerPane: '%110',
        leaderName: null,
        dialogType: 'ask_question',
        toolName: 'AskUserQuestion',
        sessionId: null,
        questions: Q_COLOR,
        sourceHookEventId: null,
      });
      // Second create expires the first
      createLeaderDialog({
        roomId: room.id,
        workerName: 'worker-1',
        workerPane: '%110',
        leaderName: null,
        dialogType: 'ask_question',
        toolName: 'AskUserQuestion',
        sessionId: null,
        questions: Q_COLOR,
        sourceHookEventId: null,
      });

      expect(listPendingDialogs(room.id)).toHaveLength(1);
      expect(listPendingDialogs(room.id)[0].id).not.toBe(d.id);
    });
  });

  describe('markDialogAnswered', () => {
    test('records ask_question answer and closes dialog', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%110');

      const d = createLeaderDialog({
        roomId: room.id,
        workerName: 'worker-1',
        workerPane: '%110',
        leaderName: null,
        dialogType: 'ask_question',
        toolName: 'AskUserQuestion',
        sessionId: null,
        questions: Q_COLOR,
        sourceHookEventId: null,
      });

      const answered = markDialogAnswered(d.id, {
        type: 'ask_question',
        picks: [0, 2],
      });
      expect(answered?.status).toBe('answered');
      expect(answered?.answer).toEqual({ type: 'ask_question', picks: [0, 2] });
      expect(answered?.answered_at).not.toBeNull();
    });

    test('records plan_approval answer', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%110');

      const d = createLeaderDialog({
        roomId: room.id,
        workerName: 'worker-1',
        workerPane: '%110',
        leaderName: null,
        dialogType: 'plan_approval',
        toolName: 'ExitPlanMode',
        sessionId: null,
        questions: null,
        sourceHookEventId: null,
      });

      const answered = markDialogAnswered(d.id, {
        type: 'plan_approval',
        approved: true,
      });
      expect(answered?.status).toBe('answered');
      expect(answered?.answer).toEqual({ type: 'plan_approval', approved: true });
    });

    test('is a no-op when dialog is not pending', () => {
      clearState();
      const room = mkRoom('room-1');
      addAgent('worker-1', 'worker', room.id, '%110');

      const d = createLeaderDialog({
        roomId: room.id,
        workerName: 'worker-1',
        workerPane: '%110',
        leaderName: null,
        dialogType: 'ask_question',
        toolName: 'AskUserQuestion',
        sessionId: null,
        questions: Q_COLOR,
        sourceHookEventId: null,
      });
      markDialogAnswered(d.id, { type: 'ask_question', picks: [1] });

      // Second answer attempt is a no-op
      expect(markDialogAnswered(d.id, { type: 'ask_question', picks: [0] })).toBeNull();
    });

    test('is a no-op for non-existent dialog', () => {
      clearState();
      expect(
        markDialogAnswered(99999, { type: 'plan_approval', approved: true }),
      ).toBeNull();
    });
  });
});
