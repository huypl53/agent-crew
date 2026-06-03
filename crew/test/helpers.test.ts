import { afterAll, describe, expect, test } from 'bun:test';
import {
  cleanupAllTestSessions,
  createTestSession,
  destroyTestSession,
} from './helpers.ts';

function requireSocket(): string {
  const socket = process.env.CREW_TMUX_SOCKET;
  if (!socket) {
    throw new Error('CREW_TMUX_SOCKET must be set for tmux helper tests');
  }
  return socket;
}

describe('tmux test helpers', () => {
  afterAll(async () => {
    await cleanupAllTestSessions();
  });

  test('createTestSession installs an isolated tmux socket', async () => {
    const session = await createTestSession('isolated-socket');
    try {
      expect(process.env.CREW_TMUX_SOCKET).toMatch(/^crew-test-/);
      const proc = Bun.spawn(['tmux', 'has-session', '-t', session.session], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const code = await proc.exited;
      expect(code).not.toBe(0);
    } finally {
      await destroyTestSession('isolated-socket');
    }
  });

  test('cleanupAllTestSessions defaults to the current test file tag', async () => {
    const session = await createTestSession('tagged-cleanup');
    const foreignSession = `cc-test-${process.pid}-foreign-suite-kept`;
    const socket = requireSocket();

    try {
      const createForeign = Bun.spawn(
        [
          'tmux',
          '-L',
          socket,
          'new-session',
          '-d',
          '-s',
          foreignSession,
          '-c',
          process.cwd(),
          '/bin/sh',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      expect(await createForeign.exited).toBe(0);

      await cleanupAllTestSessions();

      const ownProc = Bun.spawn(
        ['tmux', '-L', socket, 'has-session', '-t', session.session],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      expect(await ownProc.exited).not.toBe(0);

      const foreignProc = Bun.spawn(
        ['tmux', '-L', socket, 'has-session', '-t', foreignSession],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      expect(await foreignProc.exited).toBe(0);
    } finally {
      await destroyTestSession('tagged-cleanup').catch(() => {});
      const cleanupForeign = Bun.spawn(
        ['tmux', '-L', socket, 'kill-session', '-t', foreignSession],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      await cleanupForeign.exited;
    }
  });
});
