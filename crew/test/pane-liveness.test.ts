import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { config } from '../src/config.ts';
import { deliverMessage } from '../src/delivery/index.ts';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  addAgent,
  getAgent,
  getOrCreateRoom,
  getRoomMessages,
  validateLiveness,
} from '../src/state/index.ts';
import {
  getPaneCurrentCommand,
  paneCommandLooksAlive,
} from '../src/tmux/index.ts';
import {
  cleanupAllTestSessions,
  createTestSession,
  sendToPane,
} from './helpers.ts';

// Use fast polling so waitForReady() resolves well within default test timeouts
config.pollingProfile = 'conservative';

let shellPane: string; // always running zsh/bash
let nodePane: string; // starts a long-running node process
let sessionSeq = 0;

function mkRoom(name: string) {
  return getOrCreateRoom(`/test/${name}`, name);
}

describe('pane liveness checks', () => {
  beforeEach(async () => {
    initDb(':memory:');
    sessionSeq += 1;

    const shell = await createTestSession(`liveness-shell-${sessionSeq}`);
    shellPane = shell.pane;

    const node = await createTestSession(`liveness-node-${sessionSeq}`);
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
      addAgent('sender', 'leader', mkRoom('crew').id, shellPane, 'claude-code');
      addAgent(
        'dead-worker',
        'worker',
        mkRoom('crew').id,
        '%99999',
        'claude-code',
      );

      const results = await deliverMessage(
        'sender',
        'crew',
        'hello',
        'dead-worker',
        'push',
      );
      expect(results[0]!.delivered).toBe(false);
    });

    test('send to pane running shell (claude-code agent) returns stale-target error', async () => {
      addAgent('sender', 'leader', mkRoom('crew').id, nodePane, 'claude-code');
      addAgent(
        'stale-worker',
        'worker',
        mkRoom('crew').id,
        shellPane,
        'claude-code',
      );

      const results = await deliverMessage(
        'sender',
        'crew',
        'hello',
        'stale-worker',
        'push',
      );
      expect(results[0]!.delivered).toBe(false);
      expect(results[0]!.error).toMatch(/stale-target|no longer exists/);
      // Agent should be evicted from registry
      expect(getAgent('stale-worker')).toBeUndefined();
    });

    test('send to pane running shell (unknown agent) bypasses check and proceeds', async () => {
      addAgent('sender', 'leader', mkRoom('crew').id, shellPane, 'unknown');
      addAgent(
        'shell-worker',
        'worker',
        mkRoom('crew').id,
        shellPane,
        'unknown',
      );

      const results = await deliverMessage(
        'sender',
        'crew',
        'hello',
        'shell-worker',
        'push',
      );
      // No stale-target error — unknown agents skip the command check
      expect(results[0]!.error).not.toBe(
        `stale-target: pane ${shellPane} is not running an agent process`,
      );
    });

    test('send to pane running node (claude-code agent) reports delivered:true', async () => {
      addAgent('sender', 'leader', mkRoom('crew').id, nodePane, 'claude-code');
      addAgent(
        'live-worker',
        'worker',
        mkRoom('crew').id,
        nodePane,
        'claude-code',
      );

      const results = await deliverMessage(
        'sender',
        'crew',
        'hello',
        'live-worker',
        'push',
      );
      expect(results[0]!.delivered).toBe(true);
      expect(results[0]!.error).toBeUndefined();
    }, 15000);
  });

  describe('reminder precedence and cadence', () => {
    test('agent reminder policy overrides room default', async () => {
      const room = mkRoom('reminder-precedence');
      const roomPolicy = JSON.stringify({
        enabled: true,
        prefix: '[ROOM]',
        suffix: '',
        cadence_mode: 'always',
        cadence_n: 1,
      });
      const agentPolicy = JSON.stringify({
        enabled: true,
        prefix: '[AGENT]',
        suffix: '',
        cadence_mode: 'always',
        cadence_n: 1,
      });

      addAgent('sender', 'leader', room.id, shellPane, 'unknown');
      addAgent('target', 'worker', room.id, shellPane, 'unknown');

      const { getDb } = await import('../src/state/db.ts');
      getDb().run('UPDATE rooms SET reminder_policy = ? WHERE id = ?', [
        roomPolicy,
        room.id,
      ]);
      getDb().run('UPDATE agents SET reminder_policy = ? WHERE name = ?', [
        agentPolicy,
        'target',
      ]);

      await deliverMessage('sender', room.name, 'hello', 'target', 'push');
      const msgs = getRoomMessages(room.name);
      const latest = msgs[msgs.length - 1];
      expect(latest?.text).toBe('[AGENT] hello');
    });

    test('every_n cadence decorates only matching dispatches', async () => {
      const room = mkRoom('reminder-cadence');
      const roomPolicy = JSON.stringify({
        enabled: true,
        prefix: '[N2]',
        suffix: '',
        cadence_mode: 'every_n',
        cadence_n: 2,
      });

      addAgent('sender', 'leader', room.id, shellPane, 'unknown');
      addAgent('target', 'worker', room.id, shellPane, 'unknown');

      const { getDb } = await import('../src/state/db.ts');
      getDb().run('UPDATE rooms SET reminder_policy = ? WHERE id = ?', [
        roomPolicy,
        room.id,
      ]);

      await deliverMessage('sender', room.name, 'm1', 'target', 'push');
      await deliverMessage('sender', room.name, 'm2', 'target', 'push');

      const msgs = getRoomMessages(room.name);
      const t1 = msgs[msgs.length - 2]?.text;
      const t2 = msgs[msgs.length - 1]?.text;
      expect(t1).toBe('m1');
      expect(t2).toBe('[N2] m2');
    });

    test('failed dispatch does not increment reminder cadence counter', async () => {
      const room = mkRoom('reminder-failed-dispatch');
      const roomPolicy = JSON.stringify({
        enabled: true,
        prefix: '[N2]',
        suffix: '',
        cadence_mode: 'every_n',
        cadence_n: 2,
      });

      addAgent('sender', 'leader', room.id, shellPane, 'unknown');
      addAgent('target', 'worker', room.id, '%99999', 'claude-code');

      const { getDb } = await import('../src/state/db.ts');
      getDb().run('UPDATE rooms SET reminder_policy = ? WHERE id = ?', [
        roomPolicy,
        room.id,
      ]);

      await deliverMessage('sender', room.name, 'fails', 'target', 'push');
      getDb().run('DELETE FROM agents WHERE name = ?', ['target']);
      addAgent('target', 'worker', room.id, shellPane, 'unknown');
      await deliverMessage('sender', room.name, 'next', 'target', 'push');

      const msgs = getRoomMessages(room.name);
      const latest = msgs[msgs.length - 1];
      expect(latest?.text).toBe('next');
    });
  });

  // ── validateLiveness command check ───────────────────────────────────────────

  describe('validateLiveness with command check', () => {
    test('evicts claude-code agent whose pane reverted to a shell', async () => {
      addAgent(
        'stale-cc',
        'worker',
        mkRoom('crew').id,
        shellPane,
        'claude-code',
      );
      const dead = await validateLiveness();
      expect(dead).toContain('stale-cc');
      expect(getAgent('stale-cc')).toBeUndefined();
    });

    test('keeps unknown agent on shell pane (no false eviction)', async () => {
      addAgent(
        'shell-agent',
        'worker',
        mkRoom('crew').id,
        shellPane,
        'unknown',
      );
      const dead = await validateLiveness();
      expect(dead).not.toContain('shell-agent');
      expect(getAgent('shell-agent')).toBeDefined();
    });

    test('evicts claude-code agent on fully dead pane', async () => {
      addAgent('ghost', 'worker', mkRoom('crew').id, '%99999', 'claude-code');
      const dead = await validateLiveness();
      expect(dead).toContain('ghost');
      expect(getAgent('ghost')).toBeUndefined();
    });

    test('keeps claude-code agent whose pane is running node', async () => {
      addAgent('live-cc', 'worker', mkRoom('crew').id, nodePane, 'claude-code');
      const dead = await validateLiveness();
      expect(dead).not.toContain('live-cc');
      expect(getAgent('live-cc')).toBeDefined();
    });
  });
});
