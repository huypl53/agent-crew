import {
  afterAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { getQueue, removeQueue } from '../src/delivery/pane-queue.ts';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  addAgent,
  addHookEvent,
  getOrCreateRoom,
  setAgentInputBlockMode,
} from '../src/state/index.ts';
import {
  captureFromPane,
  cleanupAllTestSessions,
  createTestSession,
  sendToPane,
  waitForPaneOutput,
} from './helpers.ts';

// PaneQueue tests involve real tmux delivery: waitForReady (~1s) + paste settle (500ms) + Enter retry.
// Default 5000ms is too tight; bump to 15000ms for this file.
setDefaultTimeout(15000);

let testPane: string;
const SESSION = 'pane-queue-test';

describe('PaneQueue', () => {
  beforeEach(async () => {
    initDb(':memory:');
    const s = await createTestSession(SESSION);
    testPane = s.pane;
    removeQueue(testPane);
  });

  afterAll(async () => {
    await cleanupAllTestSessions();
    closeDb();
  });

  test('getQueue returns same instance for same pane', () => {
    const q1 = getQueue(testPane);
    const q2 = getQueue(testPane);
    expect(q1).toBe(q2);
  });

  test('enqueue paste delivers text to pane', async () => {
    const q = getQueue(testPane);
    await q.enqueue({ type: 'paste', text: 'hello from queue' });
    await Bun.sleep(200);
    const output = await captureFromPane(testPane);
    expect(output).toContain('hello from queue');
  });

  test('enqueue escape delivers Escape to pane', async () => {
    const q = getQueue(testPane);
    // Should not throw
    await q.enqueue({ type: 'escape' });
  });

  test('enqueue sigint delivers C-c to pane', async () => {
    const q = getQueue(testPane);
    // Should not throw
    await q.enqueue({ type: 'sigint' });
  });

  test('enqueue clear delivers Ctrl-L to pane', async () => {
    const q = getQueue(testPane);
    // Should not throw
    await q.enqueue({ type: 'clear' });
  });

  test('enqueue key delivers BSpace to pane', async () => {
    const q = getQueue(testPane);
    await q.enqueue({ type: 'key', key: 'BSpace' });
  });

  test('enqueue key-hex 7f deletes a character (Backspace UAT)', async () => {
    // Type some text so the shell has chars to erase, then send 0x7f.
    // tmux control mode encodes the resulting BS as \010 (octal) in %output.
    await sendToPane(testPane, 'printf "abc"');
    await Bun.sleep(300);

    const q = getQueue(testPane);
    // Use onReady callback: enqueue fires only AFTER the control-mode client
    // has confirmed connection (%end seen), eliminating the startup race.
    const { matched } = await waitForPaneOutput(
      testPane,
      /\\010/,
      4000,
      async () => {
        await q.enqueue({ type: 'key-hex', hex: '7f' });
      },
    );
    expect(matched).toBe(true);
  });

  test('escape and sigint items jump to front of queue', async () => {
    const q = getQueue(testPane);
    const order: string[] = [];
    // Enqueue paste then escape — escape should process first
    const p1 = q
      .enqueue({ type: 'paste', text: 'first' })
      .then(() => order.push('paste'));
    const p2 = q.enqueue({ type: 'escape' }).then(() => order.push('escape'));
    const p3 = q.enqueue({ type: 'sigint' }).then(() => order.push('sigint'));
    await Promise.all([p1, p2, p3]);
    // escape/sigint should have been processed before paste
    expect(order[2]).toBe('paste');
  });

  test('delivery still works with typing gate checks enabled', async () => {
    const q = getQueue(testPane);
    await q.enqueue({ type: 'paste', text: 'typing-gate-smoke' });
    await Bun.sleep(200);
    const output = await captureFromPane(testPane);
    expect(output).toContain('typing-gate-smoke');
  });

  test('fresh registered agent with no hook history still accepts first delivery', async () => {
    const room = getOrCreateRoom('/test/pane-queue', 'pane-queue');
    addAgent('fresh-worker', 'worker', room.id, testPane, 'claude-code');

    await sendToPane(
      testPane,
      `printf 'top\n────────────────────────────\n❯ Try "fix lint errors"\n────────────────────────────\nfooter\n'`,
    );
    await Bun.sleep(200);

    const q = getQueue(testPane);
    const startedAt = performance.now();
    await q.enqueue({ type: 'paste', text: 'first-assignment' });
    const elapsed = performance.now() - startedAt;

    const output = await captureFromPane(testPane);
    expect(output).toContain('first-assignment');
    expect(elapsed).toBeLessThan(2000);
  });

  test('paste delivery is blocked when input block is armed', async () => {
    const room = getOrCreateRoom('/test/pane-queue', 'pane-queue');
    addAgent('blocked-worker', 'worker', room.id, testPane, 'claude-code');
    setAgentInputBlockMode('blocked-worker', 'armed');
    addHookEvent('blocked-worker', 'Stop', 'sess-blocked', '{}');

    const q = getQueue(testPane, { role: 'worker' });
    await expect(
      q.enqueue({ type: 'paste', text: 'should-not-arrive' }),
    ).rejects.toThrow('input block is active');
  });

  test('command delivery bypasses input block', async () => {
    const room = getOrCreateRoom('/test/pane-queue', 'pane-queue');
    addAgent('blocked-worker', 'worker', room.id, testPane, 'claude-code');
    setAgentInputBlockMode('blocked-worker', 'persist');
    addHookEvent('blocked-worker', 'Stop', 'sess-blocked', '{}');

    const q = getQueue(testPane, { role: 'worker' });
    await q.enqueue({ type: 'command', text: 'echo bypassed-input-block' });
    await Bun.sleep(200);
    const output = await captureFromPane(testPane);
    expect(output).toContain('bypassed-input-block');
  });

  test('leader queue applies configured pace between paste deliveries', async () => {
    const q = getQueue(testPane, { role: 'leader', leaderPaceMs: 1200 });

    const t0 = performance.now();
    const p1 = q.enqueue({ type: 'paste', text: 'pace-1' });
    const p2 = q.enqueue({ type: 'paste', text: 'pace-2' });

    await Promise.all([p1, p2]);
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(1100);
  });

  test('leader command bypass is not delayed by pace', async () => {
    const q = getQueue(testPane, { role: 'leader', leaderPaceMs: 3000 });

    const t0 = performance.now();
    await q.enqueue({ type: 'command', text: 'echo bypass-command' });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(5000);
  });
});
