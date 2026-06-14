/**
 * Fixture-driven hook + tmux integration tests.
 * Each *.fixture.json in test/fixtures/hooks/ is a self-contained test case.
 * Add a new JSON file to add a new edge case — no test code changes needed.
 */

import { describe, test, expect } from 'bun:test';
import { runFixtureDir, printResults } from './lib/fixture-runner.ts';
import { resolve } from 'node:path';

const FIXTURES_DIR = resolve(import.meta.dir, 'fixtures/hooks');

describe('hook fixtures', () => {
  test('all fixture files pass', async () => {
    const results = await runFixtureDir(FIXTURES_DIR);
    const { passed, failed } = printResults(results);
    expect(results.length).toBeGreaterThan(0);
    expect(failed).toBe(0);
  }, 90_000);
});

describe('mock-hook unit', () => {
  test('malformed JSON input does not crash', async () => {
    const { MockHook } = await import('./lib/mock-hook.ts');
    const { initDb, closeDb, addAgent, getOrCreateRoom } = await import('../src/state/index.ts');
    initDb(':memory:');
    try {
      const room = getOrCreateRoom('/tmp/test', 'dev');
      addAgent('w1', 'worker', room.id, '%99');
      const hook = new MockHook({ pane: '%99' });
      const result = await hook.fireMalformed('not json {{{');
      expect(result.ok).toBe(true);
    } finally {
      closeDb();
    }
  });

  test('concurrent hook fires do not throw', async () => {
    const { MockHook } = await import('./lib/mock-hook.ts');
    const { initDb, closeDb, addAgent, getOrCreateRoom } = await import('../src/state/index.ts');
    initDb(':memory:');
    try {
      const room = getOrCreateRoom('/tmp/test', 'dev');
      addAgent('w1', 'worker', room.id, '%99');
      const hook = new MockHook({ pane: '%99' });
      const results = await hook.concurrent([
        { event: 'Stop' },
        { event: 'UserPromptSubmit' },
        { event: 'Stop' },
      ]);
      expect(results.length).toBe(3);
      expect(results.every((r) => r.ok)).toBe(true);
    } finally {
      closeDb();
    }
  });
});

describe('tmux-tap unit', () => {
  test('TmuxTap records entries and assertions work', () => {
    const { TmuxTap } = require('./lib/tmux-tap.ts');
    const tap = new TmuxTap();
    tap.log.push({ ts: Date.now(), op: 'sendKeys', target: '%42', args: ['hello world'], result: { delivered: true } });
    tap.assertSent('%42', /hello world/);
    tap.assertNotSent('%42', /goodbye/);
    tap.assertNotSent('%99', /hello/);
    expect(tap.log.length).toBe(1);
    expect(tap.getOps('sendKeys').length).toBe(1);
    expect(tap.getSendsTo('%42').length).toBe(1);
  });

  test('assertSent throws when no match', () => {
    const { TmuxTap } = require('./lib/tmux-tap.ts');
    const tap = new TmuxTap();
    expect(() => tap.assertSent('%42', /anything/)).toThrow(/No sendKeys to %42/);
  });

  test('assertEmpty passes on empty log', () => {
    const { TmuxTap } = require('./lib/tmux-tap.ts');
    const tap = new TmuxTap();
    tap.assertEmpty();
  });

  test('assertEmpty throws on non-empty log', () => {
    const { TmuxTap } = require('./lib/tmux-tap.ts');
    const tap = new TmuxTap();
    tap.log.push({ ts: Date.now(), op: 'sendKeys', target: '%1', args: ['x'] });
    expect(() => tap.assertEmpty()).toThrow(/Expected no tmux operations/);
  });

  test('toJsonl serializes log', () => {
    const { TmuxTap } = require('./lib/tmux-tap.ts');
    const tap = new TmuxTap();
    tap.log.push({ ts: 1, op: 'sendKeys', target: '%1', args: ['a'] });
    tap.log.push({ ts: 2, op: 'sendKeys', target: '%2', args: ['b'] });
    const lines = tap.toJsonl().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).target).toBe('%1');
  });
});
