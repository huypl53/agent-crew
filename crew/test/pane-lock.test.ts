import { describe, expect, setDefaultTimeout, test } from 'bun:test';

/**
 * Verifies cross-process serialization of tmux pane writes via flock.
 *
 * This is the core regression guard for the batched-`crew`-command fix: when
 * the leader fires several `crew` invocations at once, each is a separate bun
 * process with its own in-memory PaneQueue. Without a cross-process lock their
 * `tmux send-keys` sequences interleave and garble the target TUI. `withPaneLock`
 * keys an exclusive kernel flock by pane target so concurrent processes serialize.
 *
 * Here we spawn several real child processes (each loading the REAL
 * `withPaneLock`), point them at the SAME pane target, and assert their locked
 * critical sections never overlap in wall-clock time — and that at least one
 * child genuinely waited (contention really happened).
 */

setDefaultTimeout(15000);

const CHILD_TARGET = '%crew-lock-serial-test';

interface Interval {
  index: number;
  tryMs: number;
  acquireMs: number;
  releaseMs: number;
}

/** Parse a child's `<index> <try> <acquire> <release>` line into a typed tuple. */
function parseTiming(line: string): [number, number, number, number] {
  const parts = line.trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || !parts.every((n) => Number.isFinite(n))) {
    throw new Error(`bad timing line: ${JSON.stringify(line)}`);
  }
  return parts as [number, number, number, number];
}

async function runChild(index: number, holdMs: number): Promise<Interval> {
  const proc = Bun.spawn(
    [
      'bun',
      'run',
      'test/fixtures/pane-lock-child.ts',
      CHILD_TARGET,
      String(index),
      String(holdMs),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const exitCode = await proc.exited;
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();

  if (exitCode !== 0) {
    throw new Error(`child ${index} exited ${exitCode}: ${stderr || stdout}`);
  }

  const rawLine = stdout.split('\n').pop();
  if (!rawLine) throw new Error(`child ${index} produced no output`);
  // Child echoes back our `index`; skip it and take the timing fields.
  const [, tryMs, acquireMs, releaseMs] = parseTiming(rawLine);
  return {
    index,
    tryMs,
    acquireMs,
    releaseMs,
  };
}

describe('withPaneLock cross-process serialization', () => {
  test('concurrent processes on the same pane never overlap', async () => {
    const N = 4;
    const HOLD_MS = 120;

    const intervals = await Promise.all(
      Array.from({ length: N }, (_, i) => runChild(i, HOLD_MS)),
    );

    // Sort by acquire time and assert each critical section ends before the
    // next one starts — no interleaving.
    const byAcquire = [...intervals].sort((a, b) => a.acquireMs - b.acquireMs);
    for (let k = 1; k < byAcquire.length; k++) {
      const prev = byAcquire[k - 1];
      const cur = byAcquire[k];
      // k starts at 1 and stays < length, so both indices are always in range.
      if (!prev || !cur) throw new Error('unreachable: index out of bounds');
      expect(cur.acquireMs).toBeGreaterThanOrEqual(prev.releaseMs);
    }

    // With N contending processes each holding for HOLD_MS, the last grant must
    // have waited at least (N-1) * HOLD_MS minus scheduling slack. Assert real
    // contention occurred (sanity check against the lock being a no-op).
    const maxWait = Math.max(...intervals.map((iv) => iv.acquireMs - iv.tryMs));
    expect(maxWait).toBeGreaterThanOrEqual((N - 1) * HOLD_MS - 60);
  });

  test('different pane targets do not block each other', async () => {
    // Two children on DIFFERENT targets should run concurrently — their holds
    // overlap, proving the lock is per-pane and not a global mutex.
    const HOLD_MS = 150;
    const proc = (target: string, index: number) =>
      Bun.spawn(
        [
          'bun',
          'run',
          'test/fixtures/pane-lock-child.ts',
          target,
          String(index),
          String(HOLD_MS),
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
    const collect = async (p: ReturnType<typeof proc>): Promise<Interval> => {
      const exitCode = await p.exited;
      const stdout = (await new Response(p.stdout).text()).trim();
      const stderr = (await new Response(p.stderr).text()).trim();
      if (exitCode !== 0) throw new Error(stderr || stdout);
      const rawLine = stdout.split('\n').pop();
      if (!rawLine) throw new Error(stderr || stdout);
      const [childIndex, tryMs, acquireMs, releaseMs] = parseTiming(rawLine);
      return {
        index: childIndex,
        tryMs,
        acquireMs,
        releaseMs,
      };
    };

    const [a, b] = await Promise.all([
      collect(proc(`${CHILD_TARGET}-a`, 0)),
      collect(proc(`${CHILD_TARGET}-b`, 1)),
    ]);

    const overlap = a.acquireMs < b.releaseMs && b.acquireMs < a.releaseMs;
    expect(overlap).toBe(true);
  });
});
