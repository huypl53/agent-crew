import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getPaneCwd } from '../src/tmux/index.ts';
import {
  cleanupAllTestSessions,
  createTestSession,
  destroyTestSession,
} from './helpers.ts';

let testPane = '';

beforeAll(async () => {
  const session = await createTestSession('tmux-cwd');
  testPane = session.pane;
});

afterAll(async () => {
  await destroyTestSession('tmux-cwd');
  await cleanupAllTestSessions();
});

describe('getPaneCwd', () => {
  it('returns null for invalid pane', async () => {
    const result = await getPaneCwd('%99999');
    expect(result).toBeNull();
  });

  it('returns CWD for an isolated test pane', async () => {
    expect(process.env.CREW_TMUX_SOCKET).toMatch(/^crew-test-/);
    const result = await getPaneCwd(testPane);
    expect(result).not.toBeNull();
    expect(result?.startsWith('/')).toBe(true);
  });
});
