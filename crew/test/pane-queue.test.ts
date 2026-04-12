import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { createTestSession, destroyTestSession, cleanupAllTestSessions, captureFromPane } from './helpers.ts';
import { PaneQueue, getQueue } from '../src/delivery/pane-queue.ts';

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
    const p1 = q.enqueue({ type: 'paste', text: 'first' }).then(() => order.push('paste'));
    const p2 = q.enqueue({ type: 'escape' }).then(() => order.push('escape'));
    await Promise.all([p1, p2]);
    // escape should have been processed before paste
    expect(order[0]).toBe('escape');
  });
});
