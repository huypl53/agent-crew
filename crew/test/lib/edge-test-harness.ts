/**
 * Isolated tmux socket harness for edge case tests.
 * Uses `tmux -L crew-uat-edge` so all test sessions are isolated
 * from the user's real tmux server.
 */

export const SOCKET_NAME = 'crew-uat-edge';
const SESSION_NAME = 'edge-tests';

/** Run a tmux command on the isolated socket. Never throws. */
export async function runTmux(...args: string[]): Promise<{ stdout: string; success: boolean }> {
  const proc = Bun.spawn(['tmux', '-L', SOCKET_NAME, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  return { stdout: stdout.trimEnd(), success: code === 0 };
}

/** Initialize isolated tmux server + session. */
export async function setupEdgeTestEnv(): Promise<void> {
  await cleanupEdgeTestEnv(); // clean any leftover
  await runTmux('new-session', '-d', '-s', SESSION_NAME, '-x', '200', '-y', '50');
}

/** Kill entire isolated tmux server. */
export async function cleanupEdgeTestEnv(): Promise<void> {
  await runTmux('kill-server').catch(() => {});
}

/**
 * Create a pane in a new window of the isolated session.
 * Uses new-window instead of split-window to avoid "no space for new pane" errors
 * when many panes are active simultaneously.
 * @param cmd  Shell command to run in the pane (optional — defaults to bare shell)
 * @returns    Pane ID (e.g. `%3`)
 */
export async function createTestPane(cmd?: string): Promise<string> {
  const args = ['new-window', '-t', SESSION_NAME, '-P', '-F', '#{pane_id}', '-d'];
  if (cmd) args.push(cmd);
  const result = await runTmux(...args);
  return result.stdout;
}

/** Kill a specific pane by ID. */
export async function killPane(paneId: string): Promise<void> {
  await runTmux('kill-pane', '-t', paneId);
}

/** Capture pane content (last N lines). */
export async function capturePane(paneId: string, lines = 50): Promise<string> {
  const result = await runTmux('capture-pane', '-t', paneId, '-p', '-S', `-${lines}`);
  return result.stdout;
}

/** Send text + Enter to a pane via send-keys (not bracketed paste — for direct shell interaction). */
export async function sendKeys(paneId: string, text: string): Promise<void> {
  await runTmux('send-keys', '-t', paneId, '-l', text);
  await runTmux('send-keys', '-t', paneId, 'Enter');
}

/** Set mock agent mode via control file. */
export async function setAgentMode(
  agentName: string,
  mode: 'idle' | 'busy' | 'dead' | 'chaos' | 'frozen',
): Promise<void> {
  await Bun.write(`/tmp/crew-mock-${agentName}.mode`, mode);
}

/** Assert helper — returns pass/fail and increments global counters. */
export function assert(condition: boolean, label: string, detail?: string): { passed: boolean } {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return { passed: true };
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    return { passed: false };
  }
}
