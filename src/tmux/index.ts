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
  return { ok: false, error: 'cc-tmux requires tmux to be installed and available on PATH' };
}

export async function sendKeys(target: string, text: string): Promise<{ delivered: boolean; error?: string }> {
  // Send text in literal mode, then Enter separately
  const textResult = await run('send-keys', '-t', target, '-l', text);
  if (!textResult.success) {
    return { delivered: false, error: textResult.stderr || 'send-keys failed' };
  }
  const enterResult = await run('send-keys', '-t', target, 'Enter');
  if (!enterResult.success) {
    return { delivered: false, error: enterResult.stderr || 'send-keys Enter failed' };
  }
  return { delivered: true };
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
