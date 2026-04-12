import { describe, expect, test } from 'bun:test';

describe('CLI integration', () => {
  test('crew help shows usage', async () => {
    const proc = Bun.spawn(['bun', 'src/cli.ts', 'help'], {
      cwd: '/Users/lee/code/utils/agent-crew/.worktrees/feat-cli-tool',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain('crew — multi-agent coordination CLI');
  });

  test('crew rooms returns valid output', async () => {
    const proc = Bun.spawn(['bun', 'src/cli.ts', 'rooms'], {
      cwd: '/Users/lee/code/utils/agent-crew/.worktrees/feat-cli-tool',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
    expect(proc.exitCode).toBe(0);
  });

  test('crew check --name test returns version numbers', async () => {
    const proc = Bun.spawn(['bun', 'src/cli.ts', 'check', '--name', 'test'], {
      cwd: '/Users/lee/code/utils/agent-crew/.worktrees/feat-cli-tool',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toMatch(/messages:\d+ tasks:\d+ agents:\d+/);
  });

  test('crew rooms --json flag returns JSON', async () => {
    const proc = Bun.spawn(['bun', 'src/cli.ts', 'rooms', '--json'], {
      cwd: '/Users/lee/code/utils/agent-crew/.worktrees/feat-cli-tool',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test('unknown command exits with error', async () => {
    const proc = Bun.spawn(['bun', 'src/cli.ts', 'bogus'], {
      cwd: '/Users/lee/code/utils/agent-crew/.worktrees/feat-cli-tool',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
    expect(proc.exitCode).toBe(1);
  });
});
