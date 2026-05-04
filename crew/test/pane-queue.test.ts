import {
  afterAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { getQueue } from '../src/delivery/pane-queue.ts';
import {
  captureFromPane,
  cleanupAllTestSessions,
  createTestSession,
} from './helpers.ts';

// PaneQueue tests involve real tmux delivery: waitForReady (~1s) + paste settle (500ms) + Enter retry.
// Default 5000ms is too tight; bump to 15000ms for this file.
setDefaultTimeout(15000);

let testPane: string;
const SESSION = 'pane-queue-test';

describe('PaneQueue', () => {
  beforeEach(async () => {
    const s = await createTestSession(SESSION);
    testPane = s.pane;
  });

  afterAll(async () => {
    await cleanupAllTestSessions();
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

  test('enqueue clear delivers Ctrl-L to pane', async () => {
    const q = getQueue(testPane);
    // Should not throw
    await q.enqueue({ type: 'clear' });
  });

  test('escape items jump to front of queue', async () => {
    const q = getQueue(testPane);
    const order: string[] = [];
    // Enqueue paste then escape — escape should process first
    const p1 = q
      .enqueue({ type: 'paste', text: 'first' })
      .then(() => order.push('paste'));
    const p2 = q.enqueue({ type: 'escape' }).then(() => order.push('escape'));
    await Promise.all([p1, p2]);
    // escape should have been processed before paste
    expect(order[0]).toBe('escape');
  });

  test('delivery still works with typing gate checks enabled', async () => {
    const q = getQueue(testPane);
    await q.enqueue({ type: 'paste', text: 'typing-gate-smoke' });
    await Bun.sleep(200);
    const output = await captureFromPane(testPane);
    expect(output).toContain('typing-gate-smoke');
  });

  test('leader queue applies configured pace between paste deliveries', async () => {
    const q = getQueue(testPane, { role: 'leader', leaderPaceMs: 1200 });

    const t0 = Date.now();
    const p1 = q.enqueue({ type: 'paste', text: 'pace-1' });
    const p2 = q.enqueue({ type: 'paste', text: 'pace-2' });

    await Promise.all([p1, p2]);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(1100);
  });

  test('leader command bypass is not delayed by pace', async () => {
    const q = getQueue(testPane, { role: 'leader', leaderPaceMs: 3000 });

    const t0 = Date.now();
    await q.enqueue({ type: 'command', text: 'echo bypass-command' });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(1500);
  });
});
