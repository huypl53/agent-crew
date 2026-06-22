import { dlopen } from 'bun:ffi';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logServer } from '../shared/server-log.ts';

/**
 * Cross-process mutual exclusion for tmux pane writes.
 *
 * WHY: every `crew` CLI invocation is a separate process with its own in-memory
 * PaneQueue — there is no shared daemon. When the leader fires several `crew`
 * commands at once (e.g. clear + topic + goal + send), the processes race to
 * `tmux send-keys` on the same pane and their keystrokes interleave at the tmux
 * level, garbling the target TUI's input (a `/clear` then never arrives clean).
 * This lock serializes concurrent processes per pane so each write sequence is
 * atomic.
 *
 * Primary: flock(2) via FFI — a true kernel mutex that auto-releases when the
 *          holding process exits (even on crash/kill), so no stale-lock cleanup
 *          is ever needed.
 * Fallback: O_EXCL lockfile retry — used only if the flock FFI binding cannot
 *           be loaded (non-Linux/macOS, stripped libc). Insurance against a
 *           hard crash; less robust (stale lock survives a crash until timeout).
 */

const LOCK_EX = 2;
const LOCK_UN = 8;
const LOCK_TIMEOUT_MS = 10_000; // give up + warn if contended longer than this
const OEXCL_RETRY_MS = 25;

let flockFn: ((fd: number, op: number) => number) | null = null;
try {
  const libc =
    process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
  const { symbols } = dlopen(libc, {
    flock: { args: ['int', 'int'], returns: 'int' },
  });
  flockFn = symbols.flock as (fd: number, op: number) => number;
} catch (e) {
  logServer(
    'WARN',
    `pane-lock: flock FFI unavailable (${e instanceof Error ? e.message : String(e)}); falling back to O_EXCL lockfile`,
  );
}

function lockDir(): string {
  // XDG_RUNTIME_DIR is per-user and wiped on logout — ideal for lockfiles.
  const base = process.env.XDG_RUNTIME_DIR ?? tmpdir();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const dir = process.env.XDG_RUNTIME_DIR
    ? join(base, 'crew-locks')
    : join(base, `crew-${uid}-locks`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function lockPath(target: string): string {
  // Sanitize the pane id (e.g. %5) into a safe filename component.
  const safe = target.replace(/[^A-Za-z0-9%_-]/g, '_');
  return join(lockDir(), `pane-${safe}.lock`);
}

/** flock path: open the lockfile, acquire exclusive lock, run, release. */
async function withFlock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  // Guaranteed non-null: withPaneLock only dispatches here when flockFn loaded.
  const flock = flockFn;
  if (!flock) throw new Error('pane-lock: flock unavailable');
  const fd = openSync(path, 'w'); // create/open the (empty) lockfile
  try {
    flock(fd, LOCK_EX); // blocks until exclusive lock acquired
    return await fn();
  } finally {
    try {
      flock(fd, LOCK_UN);
    } catch {
      // best-effort unlock
    }
    closeSync(fd);
  }
}

/** O_EXCL fallback: create lockfile exclusively, retry until held, run, unlink. */
async function withOexcl<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired && Date.now() < deadline) {
    try {
      openSync(path, 'wx'); // O_CREAT|O_EXCL — throws EEXIST while held
      acquired = true;
    } catch {
      await Bun.sleep(OEXCL_RETRY_MS);
    }
  }
  if (!acquired) {
    // Likely a stale lock from a crashed holder — force through with a warning.
    logServer('WARN', `pane-lock: timed out on ${path}; proceeding unguarded`);
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Run `fn` while holding an exclusive lock keyed by the tmux pane target.
 * Concurrent `crew` processes writing to the SAME pane block here; `fn`'s full
 * send-keys sequence therefore never interleaves with another process's.
 */
export async function withPaneLock<T>(
  target: string,
  fn: () => Promise<T>,
): Promise<T> {
  const path = lockPath(target);
  return flockFn ? withFlock(path, fn) : withOexcl(path, fn);
}
