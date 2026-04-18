import stripAnsi from 'strip-ansi';
import { logServer } from '../shared/server-log.ts';

const SPAWN_TIMEOUT = 5000;

/**
 * Get tmux socket args if CREW_TMUX_SOCKET is set.
 * Used by tests to run against an isolated socket (e.g., `crew-uat-edge`).
 */
function getSocketArgs(): string[] {
  const socket = process.env.CREW_TMUX_SOCKET;
  return socket ? ['-L', socket] : [];
}

async function run(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  try {
    const socketArgs = getSocketArgs();
    const proc = Bun.spawn(['tmux', ...socketArgs, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => proc.kill(), SPAWN_TIMEOUT);
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return {
      stdout: stdout.trimEnd(),
      stderr: stderr.trimEnd(),
      success: exitCode === 0,
    };
  } catch (e) {
    logServer(
      'ERROR',
      `tmux spawn failed (args=${args.join(' ')}): ${e instanceof Error ? e.message : String(e)}`,
    );
    return { stdout: '', stderr: 'tmux command failed', success: false };
  }
}

export async function validateTmux(): Promise<{
  ok: boolean;
  version?: string;
  error?: string;
}> {
  const result = await run('-V');
  if (result.success) {
    return { ok: true, version: result.stdout };
  }
  return {
    ok: false,
    error: 'crew requires tmux to be installed and available on PATH',
  };
}

// Delay between paste-buffer and Enter to let the terminal app finish processing
// the bracketed paste before we submit. Empirically tested against Claude Code:
// 80ms fails, 100ms works. Using 500ms for wide margin across machines/apps.
const PASTE_SETTLE_MS = 500;

export async function sendKeys(
  target: string,
  text: string,
): Promise<{ delivered: boolean; error?: string }> {
  // Use tmux paste-buffer with bracketed paste mode (-p) instead of send-keys -l.
  //
  // Why: send-keys -l injects characters one-at-a-time. Terminal apps like Claude Code
  // detect the rapid input burst as a "paste" and collapse it into "[Pasted N lines...]".
  // Any newlines in the text become Enter keypresses mid-stream, submitting partial text.
  // The subsequent Enter key races against paste processing and gets dropped.
  //
  // paste-buffer -p wraps the text in bracketed paste escape sequences (\e[200~...\e[201~)
  // so the terminal app treats the entire payload as one atomic paste. Enter sent after
  // the paste completes then submits cleanly.
  const bufferName = `_crew_${target.replace('%', '')}`;
  try {
    // Load text into a named tmux buffer via stdin (safe for arbitrary content).
    // Must use the same socket as paste-buffer so both commands share the same server.
    const socketArgs = getSocketArgs();
    const loadProc = Bun.spawn(
      ['tmux', ...socketArgs, 'load-buffer', '-b', bufferName, '-'],
      {
        stdin: Buffer.from(text),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const loadTimeout = setTimeout(() => loadProc.kill(), SPAWN_TIMEOUT);
    const loadExit = await loadProc.exited;
    clearTimeout(loadTimeout);
    if (loadExit !== 0) {
      const stderr = await new Response(loadProc.stderr).text();
      return {
        delivered: false,
        error: stderr.trimEnd() || 'load-buffer failed',
      };
    }

    // Paste with bracketed paste mode; -d deletes the buffer after pasting
    const pasteResult = await run(
      'paste-buffer',
      '-dp',
      '-b',
      bufferName,
      '-t',
      target,
    );
    if (!pasteResult.success) {
      return {
        delivered: false,
        error: pasteResult.stderr || 'paste-buffer failed',
      };
    }

    // Let the terminal app finish processing the bracketed paste
    await Bun.sleep(PASTE_SETTLE_MS);

    // Capture pane content before Enter so we can detect whether it landed
    const contentBefore = await capturePaneLines(target, 20);

    // Submit
    const enterResult = await run('send-keys', '-t', target, 'Enter');
    if (!enterResult.success) {
      return {
        delivered: false,
        error: enterResult.stderr || 'send-keys Enter failed',
      };
    }

    // Verify Enter landed — retry up to 3 times with backoff
    for (let attempt = 0; attempt < 3; attempt++) {
      await Bun.sleep(300);
      const contentAfter = await capturePaneLines(target, 20);
      if (contentAfter !== contentBefore) {
        break; // Enter was processed, content changed
      }
      if (attempt < 2) {
        // Backoff: 500ms on attempt 0, 1000ms on attempt 1
        await Bun.sleep(500 * (attempt + 1));
        await run('send-keys', '-t', target, 'Enter'); // Retry Enter
      }
    }

    return { delivered: true };
  } catch (e) {
    // Clean up buffer on failure
    logServer(
      'ERROR',
      `paste delivery failed for target ${target}: ${e instanceof Error ? e.message : String(e)}`,
    );
    await run('delete-buffer', '-b', bufferName).catch(() => {});
    return { delivered: false, error: 'paste delivery failed' };
  }
}

export async function sendEscape(
  target: string,
): Promise<{ delivered: boolean; error?: string }> {
  try {
    const result = await run('send-keys', '-t', target, 'Escape');
    if (!result.success) {
      return {
        delivered: false,
        error: result.stderr || 'send-keys Escape failed',
      };
    }
    await Bun.sleep(PASTE_SETTLE_MS);
    return { delivered: true };
  } catch (e) {
    logServer(
      'ERROR',
      `Escape delivery failed for target ${target}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { delivered: false, error: 'Escape delivery failed' };
  }
}

export async function sendClear(
  target: string,
): Promise<{ delivered: boolean; error?: string }> {
  try {
    const result = await run('send-keys', '-t', target, 'C-l');
    if (!result.success) {
      return {
        delivered: false,
        error: result.stderr || 'send-keys C-l failed',
      };
    }
    await Bun.sleep(PASTE_SETTLE_MS);
    return { delivered: true };
  } catch (e) {
    logServer(
      'ERROR',
      `Ctrl-L delivery failed for target ${target}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { delivered: false, error: 'Ctrl-L delivery failed' };
  }
}

/** Internal helper: captures the last N lines of a pane for content-diff checks. */
async function capturePaneLines(
  target: string,
  lines: number,
): Promise<string> {
  const result = await run(
    'capture-pane',
    '-t',
    target,
    '-p',
    '-S',
    `-${lines}`,
  );
  return result.stdout || '';
}

export async function capturePane(target: string): Promise<string | null> {
  const result = await run('capture-pane', '-t', target, '-p');
  if (!result.success) return null;
  return stripAnsi(result.stdout);
}

export async function isPaneDead(target: string): Promise<boolean> {
  // display-message accepts bare pane IDs (%N) unlike list-panes which expects a window target
  const result = await run(
    'display-message',
    '-t',
    target,
    '-p',
    '#{pane_dead}',
  );
  if (!result.success) return true; // pane doesn't exist = treat as dead
  // Empty output means pane doesn't exist (tmux returns exit 0 but no output)
  const output = result.stdout.trim();
  if (output === '') return true;
  return output === '1';
}

/** Try to find a pane by ID across all known tmux sockets. Used as a fallback in paneExists. */
async function findPaneInAnySocket(target: string): Promise<boolean> {
  // Scan all tmux socket files under the standard tmux socket directories.
  // Tmux puts sockets in /private/tmp/tmux-UID/ (macOS) or /tmp/tmux-UID/ (Linux).
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const candidates = [
    `/private/tmp/tmux-${uid}`,
    `/tmp/tmux-${uid}`,
    ...(process.env.XDG_RUNTIME_DIR
      ? [`${process.env.XDG_RUNTIME_DIR}/tmux`]
      : []),
  ];

  for (const dir of candidates) {
    let names: string[];
    try {
      const ls = Bun.spawn(['ls', dir], { stdout: 'pipe', stderr: 'pipe' });
      await ls.exited;
      names = (await new Response(ls.stdout).text())
        .trim()
        .split('\n')
        .filter(Boolean);
    } catch {
      continue;
    }

    for (const name of names) {
      const sockPath = `${dir}/${name}`;
      try {
        const proc = Bun.spawn(
          [
            'tmux',
            '-S',
            sockPath,
            'display-message',
            '-t',
            target,
            '-p',
            '#{pane_id}',
          ],
          {
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const timeout = setTimeout(() => proc.kill(), 1000);
        const exitCode = await proc.exited;
        clearTimeout(timeout);
        const stdout = (await new Response(proc.stdout).text()).trim();
        if (exitCode === 0 && stdout !== '') return true;
      } catch {
        // skip unreachable socket
      }
    }
  }
  return false;
}

export async function paneExists(target: string): Promise<boolean> {
  // If we're running inside the target pane itself, trust it exists.
  // This handles macOS sandbox restrictions where subprocess can't connect to tmux socket
  // but the agent IS running in the pane (e.g., Codex CLI with "Operation not permitted").
  const currentPane = process.env.TMUX_PANE;
  if (currentPane && currentPane === target) {
    return true;
  }

  // display-message accepts bare pane IDs (%N) unlike list-panes which expects a window target
  const result = await run('display-message', '-t', target, '-p', '#{pane_id}');
  if (result.success && result.stdout.trim() !== '') return true;

  // First check failed — the configured socket (CREW_TMUX_SOCKET or $TMUX's server)
  // may not be the one where this pane lives. Scan all tmux sockets on the machine to
  // handle agents that inherited a stale/wrong socket from a test environment.
  return findPaneInAnySocket(target);
}

export async function getPaneCwd(paneId: string): Promise<string | null> {
  const result = Bun.spawnSync([
    'tmux',
    'display-message',
    '-p',
    '-t',
    paneId,
    '#{pane_current_path}',
  ]);
  if (result.exitCode !== 0) return null;
  const cwd = result.stdout.toString().trim();
  return cwd || null;
}

// Processes that indicate a live AI agent (Claude Code / Codex / bun / node)
// Use prefix match (no $) to handle architecture suffixes like "codex-aarch64-a"
const AGENT_PROC_RE = /^(node|bun|claude|codex)/i;

/** Returns the foreground command name running in a pane, or null if unreachable. */
export async function getPaneCurrentCommand(
  target: string,
): Promise<string | null> {
  const result = await run(
    'display-message',
    '-t',
    target,
    '-p',
    '#{pane_current_command}',
  );
  if (!result.success) return null;
  const cmd = result.stdout.trim();
  return cmd || null;
}

/**
 * Returns true when the pane is running a known agent process (node/bun/claude/codex).
 * Returns false for plain shells (zsh, bash, sh, fish) or unreachable panes.
 */
export async function paneCommandLooksAlive(target: string): Promise<boolean> {
  const cmd = await getPaneCurrentCommand(target);
  if (!cmd) return false;
  return AGENT_PROC_RE.test(cmd);
}
