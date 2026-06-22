import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { printTmuxWatchResults, runTmuxWatchFixtureDir } from './lib/tmux-watch-runner.ts';

const FIXTURES_DIR = resolve(import.meta.dir, 'fixtures/tmux-watch');

describe('tmux-watch fixtures', () => {
  test('all fixture files pass', async () => {
    const results = await runTmuxWatchFixtureDir(FIXTURES_DIR);
    const { failed } = printTmuxWatchResults(results);
    expect(results.length).toBeGreaterThan(0);
    expect(failed).toBe(0);
  }, 90_000);
});
