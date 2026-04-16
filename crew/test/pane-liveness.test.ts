import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { initDb, closeDb } from '../src/state/db.ts';
import { addAgent, getAgent, validateLiveness } from '../src/state/index.ts';
import { getPaneCurrentCommand, paneCommandLooksAlive } from '../src/tmux/index.ts';
import { deliverMessage } from '../src/delivery/index.ts';
import { createTestSession, cleanupAllTestSessions, sendToPane } from './helpers.ts';
import { config } from '../src/config.ts';

// Use fast polling so waitForReady() resolves well within default test timeouts
config.pollingProfile = 'conservative';

let shellPane: string;  // always running zsh/bash
let nodePane: string;   // starts a long-running node process

describe('pane liveness checks', () => {
  beforeEach(async () => {
    initDb(':memory:');

    const shell = await createTestSession('liveness-shell');
    shellPane = shell.pane;

    const node = await createTestSession('liveness-node');
    nodePane = node.pane;
    // Start a long-running node process so pane_current_command becomes 'node'
    await sendToPane(nodePane, 'node -e "setInterval(() => {}, 99999)"');
    // Wait for node to start — 400ms often isn't enough on slower machines
    await Bun.sleep(1500);
  });

  afterAll(async () => {
    await cleanupAllTestSessions();
    closeDb();
  });

  // ── tmux helpers ─────────────────────────────────────────────────────────────

  describe('getPaneCurrentCommand', () => {
    test('returns null for non-existent pane', async () => {
      expect(await getPaneCurrentCommand('%99999')).toBeNull();
    });

    test('returns shell command for shell pane', async () => {
      const cmd = await getPaneCurrentCommand(shellPane);
      expect(cmd).toBeTruthy();
      expect(['zsh', 'bash', 'sh', 'fish', 'dash']).toContain(cmd);
    });

    test('returns node for pane running node', async () => {
      const cmd = await getPaneCurrentCommand(nodePane);
      expect(cmd).toBe('node');
    });
  });

  describe('paneCommandLooksAlive', () => {
    test('returns false for non-existent pane', async () => {
      expect(await paneCommandLooksAlive('%99999')).toBe(false);
    });

    test('returns false for pane running a plain shell', async () => {
      expect(await paneCommandLooksAlive(shellPane)).toBe(false);
    });

    test('returns true for pane running node', async () => {
      expect(await paneCommandLooksAlive(nodePane)).toBe(true);
    });
  });

  // ── delivery liveness guard ───────────────────────────────────────────────────

  describe('deliverMessage liveness guard', () => {
    test('send to dead pane (non-existent) returns delivered:false', async () => {
      addAgent('sender', 'leader', 'crew', shellPane, 'claude-code');
      addAgent('dead-worker', 'worker', 'crew', '%99999', 'claude-code');

      const results = await deliverMessage('sender', 'crew', 'hello', 'dead-worker', 'push');
      expect(results[0]!.delivered).toBe(false);
    });

    test('send to pane running shell (claude-code agent) returns stale-target error', async () => {
      addAgent('sender', 'leader', 'crew', nodePane, 'claude-code');
      addAgent('stale-worker', 'worker', 'crew', shellPane, 'claude-code');

      const results = await deliverMessage('sender', 'crew', 'hello', 'stale-worker', 'push');
      expect(results[0]!.delivered).toBe(false);
      expect(results[0]!.error).toMatch(/stale-target/);
      // Agent should be evicted from registry
      expect(getAgent('stale-worker')).toBeUndefined();
    });

    test('send to pane running shell (unknown agent) bypasses check and proceeds', async () => {
      addAgent('sender', 'leader', 'crew', shellPane, 'unknown');
      addAgent('shell-worker', 'worker', 'crew', shellPane, 'unknown');

      const results = await deliverMessage('sender', 'crew', 'hello', 'shell-worker', 'push');
      // No stale-target error — unknown agents skip the command check
      expect(results[0]!.error).not.toBe(`stale-target: pane ${shellPane} is not running an agent process`);
    });

    test('send to pane running node (claude-code agent) reports delivered:true', async () => {
      addAgent('sender', 'leader', 'crew', nodePane, 'claude-code');
      addAgent('live-worker', 'worker', 'crew', nodePane, 'claude-code');

      const results = await deliverMessage('sender', 'crew', 'hello', 'live-worker', 'push');
      expect(results[0]!.delivered).toBe(true);
      expect(results[0]!.error).toBeUndefined();
    }, 15000);
  });

  // ── validateLiveness command check ───────────────────────────────────────────

  describe('validateLiveness with command check', () => {
    test('evicts claude-code agent whose pane reverted to a shell', async () => {
      addAgent('stale-cc', 'worker', 'crew', shellPane, 'claude-code');
      const dead = await validateLiveness();
      expect(dead).toContain('stale-cc');
      expect(getAgent('stale-cc')).toBeUndefined();
    });

    test('keeps unknown agent on shell pane (no false eviction)', async () => {
      addAgent('shell-agent', 'worker', 'crew', shellPane, 'unknown');
      const dead = await validateLiveness();
      expect(dead).not.toContain('shell-agent');
      expect(getAgent('shell-agent')).toBeDefined();
    });

    test('evicts claude-code agent on fully dead pane', async () => {
      addAgent('ghost', 'worker', 'crew', '%99999', 'claude-code');
      const dead = await validateLiveness();
      expect(dead).toContain('ghost');
      expect(getAgent('ghost')).toBeUndefined();
    });

    test('keeps claude-code agent whose pane is running node', async () => {
      addAgent('live-cc', 'worker', 'crew', nodePane, 'claude-code');
      const dead = await validateLiveness();
      expect(dead).not.toContain('live-cc');
      expect(getAgent('live-cc')).toBeDefined();
    });
  });
});
