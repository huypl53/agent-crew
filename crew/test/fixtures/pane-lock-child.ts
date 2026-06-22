/**
 * Child process for pane-lock serialization tests.
 *
 * Run as: `bun run test/fixtures/pane-lock-child.ts <target> <index> <holdMs>`
 *
 * Acquires the REAL `withPaneLock` (kernel flock) on `<target>`, holds it for
 * `holdMs`, then emits one line of timing to stdout:
 *
 *     <index> <tryMs> <acquireMs> <releaseMs>
 *
 * where tryMs = epoch ms before attempting to acquire, acquireMs = epoch ms
 * once the lock is granted, releaseMs = epoch ms once the lock is released.
 * The parent parses these and asserts the critical sections [acquireMs,
 * releaseMs] across children never overlap — i.e. flock serializes concurrent
 * processes on the same pane.
 *
 * A small START_DELAY_MS lets all siblings finish spawning before any child
 * contends, guaranteeing real contention (otherwise the first child could
 * release before the last child is even alive).
 */
import { withPaneLock } from '../../src/tmux/pane-lock.ts';

const START_DELAY_MS = 200;

const target = process.argv[2];
const index = process.argv[3] ?? '0';
const holdMs = Number(process.argv[4] ?? 120);

if (!target) {
  console.error('missing target arg');
  process.exit(2);
}

await Bun.sleep(START_DELAY_MS);

const tryMs = Date.now();
await withPaneLock(target, async () => {
  const acquireMs = Date.now();
  await Bun.sleep(holdMs);
  const releaseMs = Date.now();
  console.log(`${index} ${tryMs} ${acquireMs} ${releaseMs}`);
});

process.exit(0);
