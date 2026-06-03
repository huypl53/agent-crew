import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_CWD = resolve(import.meta.dir, '..');

async function runCli(
  args: string[],
  env?: Record<string, string>,
): Promise<{ out: string; err: string; exitCode: number }> {
  const proc = Bun.spawn(['bun', 'src/cli.ts', ...args], {
    cwd: CLI_CWD,
    stdout: 'pipe',
    stderr: 'pipe',
    env: env ? { ...process.env, ...env } : undefined,
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  return { out, err, exitCode: proc.exitCode };
}

async function createPaneSession(): Promise<{ session: string; panes: string[] }> {
  const create = Bun.spawn(
    [
      'tmux',
      'new-session',
      '-d',
      '-c',
      CLI_CWD,
      '-P',
      '-F',
      '#{session_name}\t#{pane_id}',
    ],
    {
      cwd: CLI_CWD,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const created = (await new Response(create.stdout).text()).trim();
  await create.exited;
  const [session, firstPane] = created.split('\t');

  const split = Bun.spawn(
    [
      'tmux',
      'split-window',
      '-d',
      '-c',
      CLI_CWD,
      '-t',
      session!,
      '-P',
      '-F',
      '#{pane_id}',
    ],
    {
      cwd: CLI_CWD,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const secondPane = (await new Response(split.stdout).text()).trim();
  await split.exited;

  return { session: session!, panes: [firstPane!, secondPane] };
}

async function killPaneSession(session: string): Promise<void> {
  const proc = Bun.spawn(['tmux', 'kill-session', '-t', session], {
    cwd: CLI_CWD,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await proc.exited;
}

describe('CLI integration', () => {
  test('crew help shows usage', async () => {
    const { out } = await runCli(['help']);
    expect(out).toContain('crew — multi-agent coordination CLI');
  });

  test('crew rooms returns valid output', async () => {
    const { exitCode } = await runCli(['rooms']);
    expect(exitCode).toBe(0);
  });

  test('crew check --name test returns version numbers', async () => {
    const { out } = await runCli(['check', '--name', 'test']);
    expect(out).toMatch(/messages:\d+ tasks:\d+ agents:\d+/);
  });

  test('crew rooms --json flag returns JSON', async () => {
    const { out } = await runCli(['rooms', '--json']);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test('unknown command exits with error', async () => {
    const { exitCode } = await runCli(['bogus']);
    expect(exitCode).toBe(1);
  });

  test('crew send --file reads UTF-8 content exactly', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'crew-cli-file-'));
    const relDir = mkdtempSync(join(CLI_CWD, '.tmp-crew-cli-cwd-'));
    const tmux = await createPaneSession();
    const taskFile = join(relDir, 'task.txt');
    writeFileSync(taskFile, 'line 1\nline 2\n');

    try {
      let result = await runCli(
        [
          'join',
          '--room',
          'file-room',
          '--role',
          'leader',
          '--name',
          'lead-1',
          '--pane',
          tmux.panes[0]!,
        ],
        { CREW_STATE_DIR: stateDir },
      );
      expect(result.exitCode).toBe(0);

      result = await runCli(
        [
          'join',
          '--room',
          'file-room',
          '--role',
          'worker',
          '--name',
          'worker-1',
          '--pane',
          tmux.panes[1]!,
        ],
        { CREW_STATE_DIR: stateDir },
      );
      expect(result.exitCode).toBe(0);

      result = await runCli(
        [
          'send',
          '--room',
          'file-room',
          '--to',
          'worker-1',
          '--file',
          `${relDir.split('/').pop()}/task.txt`,
          '--name',
          'lead-1',
          '--mode',
          'pull',
        ],
        { CREW_STATE_DIR: stateDir },
      );
      expect(result.exitCode).toBe(0);

      result = await runCli(
        ['read', '--name', 'worker-1', '--room', 'file-room', '--json'],
        { CREW_STATE_DIR: stateDir },
      );
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.out);
      expect(payload.messages).toHaveLength(1);
      expect(payload.messages[0].text).toBe('line 1\nline 2\n');
    } finally {
      await killPaneSession(tmux.session);
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(relDir, { recursive: true, force: true });
    }
  });

  test('crew send rejects --text together with --file', async () => {
    const fileDir = mkdtempSync(join(tmpdir(), 'crew-cli-file-mix-'));
    const taskFile = join(fileDir, 'task.txt');
    writeFileSync(taskFile, 'hello');
    try {
      const result = await runCli([
        'send',
        '--room',
        'mix-room',
        '--to',
        'worker-1',
        '--text',
        'inline',
        '--file',
        taskFile,
        '--name',
        'lead-1',
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.err).toContain('Provide exactly one of --text or --file');
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });

  test('crew send rejects missing file', async () => {
    const result = await runCli([
      'send',
      '--room',
      'missing-room',
      '--to',
      'worker-1',
      '--file',
      '/definitely/missing/task.txt',
      '--name',
      'lead-1',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.err).toContain('Unable to read message file');
  });

  test('crew send rejects invalid UTF-8 file content', async () => {
    const fileDir = mkdtempSync(join(tmpdir(), 'crew-cli-file-badutf8-'));
    const taskFile = join(fileDir, 'task.bin');
    writeFileSync(taskFile, Buffer.from([0xc3, 0x28]));
    try {
      const result = await runCli([
        'send',
        '--room',
        'utf8-room',
        '--to',
        'worker-1',
        '--file',
        taskFile,
        '--name',
        'lead-1',
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.err).toContain('Message file is not valid UTF-8');
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });
});
