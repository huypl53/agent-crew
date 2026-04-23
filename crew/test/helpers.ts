const TEST_SESSION_PREFIX = `cc-test-${process.pid}-`;

export function getCallerTestTag(): string {
  const stack = new Error().stack ?? '';
  const line = stack
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.includes('/test/') && !l.includes('/test/helpers.ts'));

  const match = line?.match(/\/([^/]+\.test\.(?:ts|tsx|js|jsx))(?::\d+:\d+)?/);
  const file = match?.[1] ?? 'generic';
  return file
    .replace(/\.test\.(?:ts|tsx|js|jsx)$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '-');
}

function sessionName(name: string): string {
  return `${TEST_SESSION_PREFIX}${getCallerTestTag()}-${name}`;
}

export async function createTestSession(
  name: string,
): Promise<{ session: string; pane: string }> {
  const session = sessionName(name);

  // Kill existing session if any
  await runTmux('kill-session', '-t', session).catch(() => {});

  // Create new session with /bin/sh to avoid zsh/oh-my-zsh init race
  const proc = Bun.spawn(
    [
      'tmux',
      'new-session',
      '-d',
      '-s',
      session,
      '-c',
      process.cwd(),
      '-x',
      '120',
      '-y',
      '40',
      '/bin/sh',
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  await proc.exited;

  // Get the pane ID
  const paneProc = Bun.spawn(
    ['tmux', 'list-panes', '-t', session, '-F', '#{pane_id}'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  await paneProc.exited;
  const pane = (await new Response(paneProc.stdout).text()).trim();

  return { session, pane };
}

export async function destroyTestSession(name: string): Promise<void> {
  const session = sessionName(name);
  await runTmux('kill-session', '-t', session).catch(() => {});
}

export async function sendToPane(target: string, text: string): Promise<void> {
  await runTmux('send-keys', '-t', target, '-l', text);
  await runTmux('send-keys', '-t', target, 'Enter');
}

export async function captureFromPane(target: string): Promise<string> {
  const proc = Bun.spawn(['tmux', 'capture-pane', '-t', target, '-p'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await proc.exited;
  return (await new Response(proc.stdout).text()).trimEnd();
}

async function runTmux(...args: string[]): Promise<string> {
  const proc = Bun.spawn(['tmux', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tmux ${args.join(' ')} failed: ${stderr}`);
  }
  return out.trimEnd();
}

export async function cleanupAllTestSessions(tag?: string): Promise<void> {
  try {
    const proc = Bun.spawn(['tmux', 'list-sessions', '-F', '#{session_name}'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
    const output = await new Response(proc.stdout).text();
    const prefix = tag ? `${TEST_SESSION_PREFIX}${tag}-` : TEST_SESSION_PREFIX;
    const sessions = output
      .trim()
      .split('\n')
      .filter((s) => s.startsWith(prefix));
    for (const session of sessions) {
      await runTmux('kill-session', '-t', session).catch(() => {});
    }
  } catch {
    // No tmux server running — nothing to clean
  }
}
