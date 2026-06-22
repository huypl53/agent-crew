import { afterAll, describe, expect, test } from 'bun:test';
import {
  getPaneStatus,
  parsePaneInputSection,
} from '../src/shared/pane-status.ts';
import { closeDb, initDb } from '../src/state/db.ts';
import { addAgent, getOrCreateRoom } from '../src/state/index.ts';
import {
  cleanupAllTestSessions,
  createTestSession,
  destroyTestSession,
  sendPaneMarker,
} from './helpers.ts';

describe('parsePaneInputSection', () => {
  test('detects typing when chars between separators exceed threshold', () => {
    const pane = [
      'line above',
      '────────────────────────────',
      '❯ hello',
      '────────────────────────────',
      'status line',
    ].join('\n');

    const parsed = parsePaneInputSection(pane, 28);
    expect(parsed.typingActive).toBe(true);
    expect(parsed.inputChars).toBeGreaterThanOrEqual(5);
    expect(parsed.sanitized).toBe('line above');
  });

  test('does not detect typing when input chars are below threshold', () => {
    const pane = [
      'line above',
      '────────────────────────────',
      '❯ a',
      '────────────────────────────',
      'status line',
    ].join('\n');

    const parsed = parsePaneInputSection(pane, 28);
    expect(parsed.typingActive).toBe(false);
    expect(parsed.inputChars).toBeLessThan(4);
    expect(parsed.sanitized).toBe('line above');
  });

  test('falls back when separators are missing', () => {
    const pane = ['line a', 'line b', 'line c'].join('\n');
    const parsed = parsePaneInputSection(pane, 28);
    expect(parsed.typingActive).toBe(false);
    expect(parsed.inputChars).toBe(0);
    expect(parsed.sanitized).toBe(pane);
  });

  test('supports narrow panes with dynamic threshold', () => {
    const pane = [
      'top',
      '─────────────',
      '❯ typing',
      '─────────────',
      'footer',
    ].join('\n');

    const parsed = parsePaneInputSection(pane, 13);
    expect(parsed.typingActive).toBe(true);
    expect(parsed.sanitized).toBe('top');
  });
});

describe('getPaneStatus', () => {
  afterAll(async () => {
    await cleanupAllTestSessions();
    closeDb();
  });

  test('keeps no-hook panes unknown while still tracking content changes', async () => {
    initDb(':memory:');
    const session = await createTestSession('pane-status-no-hook-observation');

    try {
      const room = getOrCreateRoom('/test/pane-status', 'pane-status');
      addAgent(
        'pane-status-worker',
        'worker',
        room.id,
        session.pane,
        'claude-code',
      );

      const initial = await getPaneStatus(session.pane);
      expect(initial.status).toBe('unknown');
      expect(initial.contentChanged).toBe(false);

      await sendPaneMarker(session.pane, 'observation-change');

      const changed = await getPaneStatus(session.pane);
      expect(changed.status).toBe('unknown');
      expect(changed.contentChanged).toBe(true);
    } finally {
      await destroyTestSession('pane-status-no-hook-observation');
    }
  });

  test('returns unknown instead of throwing when pane cache is warm but DB is closed', async () => {
    initDb(':memory:');
    const session = await createTestSession('pane-status-db-closed');

    try {
      const room = getOrCreateRoom('/test/pane-status', 'pane-status');
      addAgent(
        'pane-status-worker',
        'worker',
        room.id,
        session.pane,
        'claude-code',
      );

      const initial = await getPaneStatus(session.pane);
      expect(initial.status).toBe('unknown');

      closeDb();

      const result = await getPaneStatus(session.pane);
      expect(result.status).toBe('unknown');
      expect(result.contentChanged).toBe(false);
    } finally {
      await destroyTestSession('pane-status-db-closed');
    }
  });
});
