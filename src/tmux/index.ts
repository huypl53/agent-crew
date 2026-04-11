import stripAnsi from 'strip-ansi';

const SPAWN_TIMEOUT = 5000;

async function run(...args: string[]): Promise<{ stdout: string; stderr: string; success: boolean }> {
  try {
    const proc = Bun.spawn(['tmux', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => proc.kill(), SPAWN_TIMEOUT);
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), success: exitCode === 0 };
  } catch {
    return { stdout: '', stderr: 'tmux command failed', success: false };
  }
}

export async function validateTmux(): Promise<{ ok: boolean; version?: string; error?: string }> {
  const result = await run('-V');
  if (result.success) {
    return { ok: true, version: result.stdout };
  }
  return { ok: false, error: 'crew requires tmux to be installed and available on PATH' };
}

// Delay between paste-buffer and Enter to let the terminal app finish processing
// the bracketed paste before we submit. Empirically tested against Claude Code:
// 80ms fails, 100ms works. Using 500ms for wide margin across machines/apps.
const PASTE_SETTLE_MS = 500;

export async function sendKeys(target: string, text: string): Promise<{ delivered: boolean; error?: string }> {
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
    // Load text into a named tmux buffer via stdin (safe for arbitrary content)
    const loadProc = Bun.spawn(['tmux', 'load-buffer', '-b', bufferName, '-'], {
      stdin: Buffer.from(text),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const loadTimeout = setTimeout(() => loadProc.kill(), SPAWN_TIMEOUT);
    const loadExit = await loadProc.exited;
    clearTimeout(loadTimeout);
    if (loadExit !== 0) {
      const stderr = await new Response(loadProc.stderr).text();
      return { delivered: false, error: stderr.trimEnd() || 'load-buffer failed' };
    }

    // Paste with bracketed paste mode; -d deletes the buffer after pasting
    const pasteResult = await run('paste-buffer', '-dp', '-b', bufferName, '-t', target);
    if (!pasteResult.success) {
      return { delivered: false, error: pasteResult.stderr || 'paste-buffer failed' };
    }

    // Let the terminal app finish processing the bracketed paste
    await Bun.sleep(PASTE_SETTLE_MS);

    // Submit
    const enterResult = await run('send-keys', '-t', target, 'Enter');
    if (!enterResult.success) {
      return { delivered: false, error: enterResult.stderr || 'send-keys Enter failed' };
    }

    return { delivered: true };
  } catch {
    // Clean up buffer on failure
    await run('delete-buffer', '-b', bufferName).catch(() => {});
    return { delivered: false, error: 'paste delivery failed' };
  }
}

export async function sendEscape(target: string): Promise<{ delivered: boolean; error?: string }> {
  try {
    const result = await run('send-keys', '-t', target, 'Escape');
    if (!result.success) {
      return { delivered: false, error: result.stderr || 'send-keys Escape failed' };
    }
    await Bun.sleep(PASTE_SETTLE_MS);
    return { delivered: true };
  } catch {
    return { delivered: false, error: 'Escape delivery failed' };
  }
}

export async function sendClear(target: string): Promise<{ delivered: boolean; error?: string }> {
  try {
    const result = await run('send-keys', '-t', target, 'C-l');
    if (!result.success) {
      return { delivered: false, error: result.stderr || 'send-keys C-l failed' };
    }
    await Bun.sleep(PASTE_SETTLE_MS);
    return { delivered: true };
  } catch {
    return { delivered: false, error: 'Ctrl-L delivery failed' };
  }
}

export async function capturePane(target: string): Promise<string | null> {
  const result = await run('capture-pane', '-t', target, '-p');
  if (!result.success) return null;
  return stripAnsi(result.stdout);
}

export async function isPaneDead(target: string): Promise<boolean> {
  const result = await run('list-panes', '-t', target, '-F', '#{pane_dead}');
  if (!result.success) return true; // pane/session doesn't exist = dead
  return result.stdout.trim() === '1';
}

export async function paneExists(target: string): Promise<boolean> {
  const result = await run('list-panes', '-t', target, '-F', '#{pane_id}');
  return result.success;
}
