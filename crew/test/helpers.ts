import { resetQueues } from '../src/delivery/pane-queue.ts';

const TEST_SESSION_PREFIX = `cc-test-${process.pid}-`;
const TEST_TMUX_SOCKET = `crew-test-${process.pid}`;

function getSocketName(): string {
  return TEST_TMUX_SOCKET;
}

function getSocketArgs(): string[] {
  return ['-L', getSocketName()];
}

function ensureTestTmuxSocketEnv(): void {
  process.env.CREW_TMUX_SOCKET = getSocketName();
}

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
  ensureTestTmuxSocketEnv();
  const session = sessionName(name);

  // Kill existing session if any
  await runTmux('kill-session', '-t', session).catch(() => {});

  // Create new session with /bin/sh to avoid zsh/oh-my-zsh init race
  const proc = Bun.spawn(
    [
      'tmux',
      ...getSocketArgs(),
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
    [
      'tmux',
      ...getSocketArgs(),
      'list-panes',
      '-t',
      session,
      '-F',
      '#{pane_id}',
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  await paneProc.exited;
  const pane = (await new Response(paneProc.stdout).text()).trim();

  // Let the fresh /bin/sh pane settle to its first prompt before tests start
  // sending markers or relying on queued deliveries.
  await waitForPaneToContain(pane, '$', { timeoutMs: 2000, intervalMs: 50 }).catch(
    () => {},
  );

  return { session, pane };
}

export async function destroyTestSession(name: string): Promise<void> {
  ensureTestTmuxSocketEnv();
  const session = sessionName(name);
  await runTmux('kill-session', '-t', session).catch(() => {});
}

export async function sendToPane(target: string, text: string): Promise<void> {
  ensureTestTmuxSocketEnv();
  await runTmux('send-keys', '-t', target, '-l', text);
  await runTmux('send-keys', '-t', target, 'Enter');
}

function escapeSingleQuotedShell(value: string): string {
  return value.replace(/'/g, `'"'"'`);
}

export async function sendPaneMarker(target: string, marker: string): Promise<void> {
  const escaped = escapeSingleQuotedShell(marker);
  await sendToPane(target, `printf '%s\\n' '${escaped}'`);
}

export async function captureFromPane(target: string): Promise<string> {
  ensureTestTmuxSocketEnv();
  const proc = Bun.spawn(
    ['tmux', ...getSocketArgs(), 'capture-pane', '-t', target, '-p', '-S', '-200'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  await proc.exited;
  return (await new Response(proc.stdout).text()).trimEnd();
}

export async function capturePaneAfterMarker(
  target: string,
  marker: string,
): Promise<string> {
  const output = await captureFromPane(target);
  const idx = output.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error(`Marker not found in pane ${target}: ${marker}`);
  }
  return output.slice(idx + marker.length);
}

export async function waitForPaneToContain(
  target: string,
  expected: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const intervalMs = opts?.intervalMs ?? 100;
  const start = Date.now();

  let last = '';
  while (Date.now() - start < timeoutMs) {
    last = await captureFromPane(target);
    if (last.includes(expected)) return last;
    await Bun.sleep(intervalMs);
  }

  throw new Error(
    [
      `Timed out waiting for pane ${target} to contain:`,
      expected,
      '--- last capture ---',
      last,
    ].join('\n'),
  );
}

export async function waitForPaneAfterMarkerToContain(
  target: string,
  marker: string,
  expected: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const intervalMs = opts?.intervalMs ?? 100;
  const start = Date.now();

  let last = '';
  while (Date.now() - start < timeoutMs) {
    last = await capturePaneAfterMarker(target, marker);
    if (last.includes(expected)) return last;
    await Bun.sleep(intervalMs);
  }

  throw new Error(
    [
      `Timed out waiting for pane ${target} after marker to contain:`,
      expected,
      `marker: ${marker}`,
      '--- last capture ---',
      last,
    ].join('\n'),
  );
}

export async function assertPaneAfterMarkerLacks(
  target: string,
  marker: string,
  unexpected: string,
  opts?: { settleMs?: number; intervalMs?: number },
): Promise<string> {
  const settleMs = opts?.settleMs ?? 800;
  const intervalMs = opts?.intervalMs ?? 100;
  const start = Date.now();

  let last = '';
  while (Date.now() - start < settleMs) {
    last = await capturePaneAfterMarker(target, marker);
    if (last.includes(unexpected)) {
      throw new Error(
        [
          `Pane ${target} unexpectedly contained text after marker:`,
          unexpected,
          `marker: ${marker}`,
          '--- capture ---',
          last,
        ].join('\n'),
      );
    }
    await Bun.sleep(intervalMs);
  }

  return last;
}

export function expectTextInOrder(haystack: string, parts: string[]): void {
  let cursor = -1;
  for (const part of parts) {
    const idx = haystack.indexOf(part, cursor + 1);
    if (idx === -1) {
      throw new Error(
        [`Expected text not found in order: ${part}`, '--- haystack ---', haystack].join(
          '\n',
        ),
      );
    }
    cursor = idx;
  }
}

async function runTmux(...args: string[]): Promise<string> {
  ensureTestTmuxSocketEnv();
  const proc = Bun.spawn(['tmux', ...getSocketArgs(), ...args], {
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
  ensureTestTmuxSocketEnv();
  resetQueues();
  try {
    const proc = Bun.spawn(
      ['tmux', ...getSocketArgs(), 'list-sessions', '-F', '#{session_name}'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    await proc.exited;
    const output = await new Response(proc.stdout).text();
    const resolvedTag = tag ?? getCallerTestTag();
    const prefix = `${TEST_SESSION_PREFIX}${resolvedTag}-`;
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

/**
 * Wait for a pane to emit output matching `pattern` using tmux control mode.
 *
 * Opens a `-C attach` control-mode client on the test socket and listens to
 * live `%output <paneId> <data>` lines. This is more reliable than polling
 * `capture-pane` because it receives data as it arrives — no sleep timers,
 * no stale snapshots, no cross-session contamination.
 *
 * Usage pattern to avoid startup race:
 *   const result = await waitForPaneOutput(pane, /pattern/, 4000, async () => {
 *     // This callback fires only AFTER control mode is connected (%end seen).
 *     await queue.enqueue(...);
 *   });
 *
 * @param target     Pane ID to watch (e.g. '%5')
 * @param pattern    String or RegExp to match against each output chunk
 * @param timeoutMs  Max wait time in milliseconds (default 5000)
 * @param onReady    Optional async callback called once control mode is connected
 */
export async function waitForPaneOutput(
  target: string,
  pattern: string | RegExp,
  timeoutMs = 5000,
  onReady?: () => Promise<void>,
): Promise<{ matched: boolean; seen: string }> {
  ensureTestTmuxSocketEnv();

  // Find which session the pane belongs to so we can attach to it
  const sessionOut = await runTmux(
    'display-message',
    '-t',
    target,
    '-p',
    '#{session_name}',
  ).catch(() => '');
  const session = sessionOut.trim();
  if (!session) return { matched: false, seen: '' };

  const seen: string[] = [];
  const sourceRe = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
  const re = new RegExp(sourceRe.source, sourceRe.flags.replace(/g/g, ''));
  const outputPrefix = `%output ${target} `;

  const proc = Bun.spawn(
    ['tmux', ...getSocketArgs(), '-C', 'attach-session', '-t', session],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );

  let resolved = false;
  let matched = false;
  let readyFired = false;

  const deadline = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      proc.stdin.end();
      proc.kill();
    }
  }, timeoutMs);

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (!resolved) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // tmux control mode uses CRLF line endings
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) {
        // Fire onReady after the first %end guard — control mode is now live
        if (!readyFired && line.startsWith('%end') && onReady) {
          readyFired = true;
          // Don't await inline — let the read loop continue while action runs
          onReady().catch(() => {});
        }
        if (!line.startsWith(outputPrefix)) continue;
        const chunk = line.slice(outputPrefix.length);
        seen.push(chunk);
        const combined = seen.join('');
        if (re.test(combined)) {
          matched = true;
          resolved = true;
          proc.stdin.end();
          proc.kill();
          break;
        }
      }
    }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }

  return { matched, seen: seen.join('') };
}
