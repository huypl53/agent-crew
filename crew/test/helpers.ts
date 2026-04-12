const TEST_SESSION_PREFIX = 'cc-test-';

export async function createTestSession(name: string): Promise<{ session: string; pane: string }> {
  const session = `${TEST_SESSION_PREFIX}${name}`;

  // Kill existing session if any
  await runTmux('kill-session', '-t', session).catch(() => {});

  // Create new session with a simple shell
  const proc = Bun.spawn(['tmux', 'new-session', '-d', '-s', session, '-x', '120', '-y', '40'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await proc.exited;

  // Get the pane ID
  const paneProc = Bun.spawn(['tmux', 'list-panes', '-t', session, '-F', '#{pane_id}'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await paneProc.exited;
  const pane = (await new Response(paneProc.stdout).text()).trim();

  return { session, pane };
}

export async function destroyTestSession(name: string): Promise<void> {
  const session = `${TEST_SESSION_PREFIX}${name}`;
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

export async function cleanupAllTestSessions(): Promise<void> {
  try {
    const proc = Bun.spawn(['tmux', 'list-sessions', '-F', '#{session_name}'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
    const output = await new Response(proc.stdout).text();
    const sessions = output.trim().split('\n').filter(s => s.startsWith(TEST_SESSION_PREFIX));
    for (const session of sessions) {
      await runTmux('kill-session', '-t', session).catch(() => {});
    }
  } catch {
    // No tmux server running — nothing to clean
  }
}
