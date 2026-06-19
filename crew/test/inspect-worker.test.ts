import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { inspectWorkerTurns } from '../src/observation/gateway.ts';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  addAgent,
  addHookEvent,
  clearState,
  getOrCreateRoom,
} from '../src/state/index.ts';

function mkRoom(name: string) {
  return getOrCreateRoom(`/test/${name}`, name);
}

describe('worker inspection gateway', () => {
  beforeEach(() => {
    initDb(':memory:');
    clearState();
    addAgent('lead-1', 'leader', mkRoom('frontend').id, '%1', 'claude-code');
    addAgent('worker-1', 'worker', mkRoom('frontend').id, '%2', 'claude-code');
    addHookEvent(
      'worker-1',
      'UserPromptSubmit',
      'sess-1',
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-1',
      }),
    );
  });

  afterEach(() => {
    closeDb();
  });

  test('returns transcript-backed inspection for a Claude worker', async () => {
    const snapshot = await inspectWorkerTurns(
      {
        workerName: 'worker-1',
        roomName: 'frontend',
        callerName: 'lead-1',
        turns: 4,
      },
      {
        transcriptLoader: async () =>
          [
            JSON.stringify({
              type: 'user',
              timestamp: '2026-06-03T10:00:00.000Z',
              message: { role: 'user', content: 'Run tests' },
            }),
            JSON.stringify({
              type: 'assistant',
              timestamp: '2026-06-03T10:00:02.000Z',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Running tests now.' }],
              },
            }),
          ].join('\n'),
        sessionResolver: async () => ({
          sessionId: 'sess-1',
          sessionPath: '/tmp/worker-1.jsonl',
        }),
      },
    );

    expect(snapshot.source).toBe('transcript');
    expect(snapshot.degraded).toBe(false);
    expect(snapshot.turns).toEqual([
      {
        role: 'user',
        text: 'Run tests',
        timestamp: '2026-06-03T10:00:00.000Z',
      },
      {
        role: 'assistant',
        text: 'Running tests now.',
        timestamp: '2026-06-03T10:00:02.000Z',
      },
    ]);
  });

  test('allows transcript-backed inspection for workers classified as unknown', async () => {
    addAgent('lead-unknown', 'leader', mkRoom('unknown-room').id, '%9', 'claude-code');
    addAgent('worker-unknown', 'worker', mkRoom('unknown-room').id, '%10', 'unknown');
    addHookEvent(
      'worker-unknown',
      'UserPromptSubmit',
      'sess-unknown',
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-unknown',
      }),
    );

    const snapshot = await inspectWorkerTurns(
      {
        workerName: 'worker-unknown',
        roomName: 'unknown-room',
        callerName: 'lead-unknown',
        turns: 4,
      },
      {
        transcriptLoader: async () =>
          [
            JSON.stringify({
              type: 'user',
              timestamp: '2026-06-03T10:10:00.000Z',
              message: { role: 'user', content: 'Please summarize progress' },
            }),
            JSON.stringify({
              type: 'assistant',
              timestamp: '2026-06-03T10:10:03.000Z',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Benchmark is still running.' }],
              },
            }),
          ].join('\n'),
        sessionResolver: async () => ({
          sessionId: 'sess-unknown',
          sessionPath: '/tmp/worker-unknown.jsonl',
        }),
      },
    );

    expect(snapshot.source).toBe('transcript');
    expect(snapshot.degraded).toBe(false);
    expect(snapshot.provider).toBe('unknown');
    expect(snapshot.turns).toEqual([
      {
        role: 'user',
        text: 'Please summarize progress',
        timestamp: '2026-06-03T10:10:00.000Z',
      },
      {
        role: 'assistant',
        text: 'Benchmark is still running.',
        timestamp: '2026-06-03T10:10:03.000Z',
      },
    ]);
  });

  test('falls back to hook-only degraded inspection when transcript is unavailable', async () => {
    addHookEvent(
      'worker-1',
      'Stop',
      'sess-1',
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'sess-1',
        last_assistant_message: 'Need permission to run tests.',
      }),
    );

    const snapshot = await inspectWorkerTurns(
      {
        workerName: 'worker-1',
        roomName: 'frontend',
        callerName: 'lead-1',
        turns: 4,
      },
      {
        transcriptLoader: async () => null,
        sessionResolver: async () => ({
          sessionId: 'sess-1',
          sessionPath: '/tmp/worker-1.jsonl',
        }),
      },
    );

    expect(snapshot.source).toBe('hook-events');
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.degradation_reason).toBe('transcript_unavailable');
    expect(snapshot.turns).toEqual([
      {
        role: 'assistant',
        text: 'Need permission to run tests.',
        timestamp: expect.any(String),
      },
    ]);
  });

  test('hook fallback does not surface stale stop text after newer activity', async () => {
    addHookEvent(
      'worker-1',
      'Stop',
      'sess-1',
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'sess-1',
        last_assistant_message: 'Old stop message.',
      }),
    );
    addHookEvent(
      'worker-1',
      'UserPromptSubmit',
      'sess-1',
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-1',
        nonce: 'new-activity',
      }),
    );

    const snapshot = await inspectWorkerTurns(
      {
        workerName: 'worker-1',
        roomName: 'frontend',
        callerName: 'lead-1',
        turns: 4,
      },
      {
        transcriptLoader: async () => null,
        sessionResolver: async () => ({
          sessionId: 'sess-1',
          sessionPath: '/tmp/worker-1.jsonl',
        }),
      },
    );

    expect(snapshot.source).toBe('hook-events');
    expect(snapshot.status).toBe('busy');
    expect(snapshot.turns).toEqual([]);
    expect(snapshot.updated_at).toEqual(expect.any(String));
  });

  test('filters hook fallback by resolved session when same worker name exists in another room', async () => {
    addAgent('lead-1', 'leader', mkRoom('company').id, '%3', 'claude-code');
    addAgent('worker-1', 'worker', mkRoom('company').id, '%4', 'claude-code');
    addHookEvent(
      'worker-1',
      'Stop',
      'sess-company',
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'sess-company',
        last_assistant_message: 'Company room stop message.',
      }),
    );
    addHookEvent(
      'worker-1',
      'Stop',
      'sess-frontend',
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'sess-frontend',
        last_assistant_message: 'Frontend room stop message.',
      }),
    );

    const snapshot = await inspectWorkerTurns(
      {
        workerName: 'worker-1',
        roomName: 'frontend',
        callerName: 'lead-1',
        turns: 4,
      },
      {
        transcriptLoader: async () => null,
        sessionResolver: async () => ({
          sessionId: 'sess-frontend',
          sessionPath: '/tmp/worker-1-frontend.jsonl',
        }),
      },
    );

    expect(snapshot.source).toBe('hook-events');
    expect(snapshot.turns[0]?.text).toBe('Frontend room stop message.');
  });

  test('supports codex workers in gateway inspection', async () => {
    addHookEvent(
      'codex-worker',
      'Stop',
      'codex-session',
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'codex-session',
        last_assistant_message: 'Codex worker stopped.',
      }),
    );
    addAgent('codex-lead', 'leader', mkRoom('codex-room').id, '%5', 'claude-code');
    addAgent(
      'codex-worker',
      'worker',
      mkRoom('codex-room').id,
      '%6',
      'codex',
    );

    const snapshot = await inspectWorkerTurns({
      workerName: 'codex-worker',
      roomName: 'codex-room',
      callerName: 'codex-lead',
      turns: 4,
    });

    expect(snapshot.source).toBe('hook-events');
    expect(snapshot.provider).toBe('codex');
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.turns).toEqual([
      {
        role: 'assistant',
        text: 'Codex worker stopped.',
        timestamp: expect.any(String),
      },
    ]);
  });
});
