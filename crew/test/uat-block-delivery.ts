#!/usr/bin/env bun
/**
 * UAT: Input-block delivery correctness.
 *
 * Verifies end-to-end through a real crew server + real tmux panes:
 *
 *   Scenario A (block=off):
 *     Worker fires Stop hook → leader pane receives completion notification ✓
 *
 *   Scenario B (block=persist):
 *     Worker fires Stop hook → leader pane does NOT receive notification ✓
 *
 * Usage:
 *   bun crew/test/uat-block-delivery.ts
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DIR = join(tmpdir(), 'crew-block-uat');
const SESSION = 'crew-block-uat';
const ROOM = 'block-test-room';

let passed = 0;
let failed = 0;
let serverProc: ReturnType<typeof Bun.spawn> | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assert(ok: boolean, label: string, detail?: string) {
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function exec(
  cmd: string[],
  opts?: { stdin?: string; env?: Record<string, string>; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: opts?.stdin ? new Response(opts.stdin) : 'ignore',
    env: { ...process.env, CREW_STATE_DIR: join(TEST_DIR, 'state'), ...opts?.env },
  });
  const timer = setTimeout(() => proc.kill(), opts?.timeout ?? 10_000);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function crew(
  args: string[],
  opts?: { stdin?: string; env?: Record<string, string> },
): Promise<string> {
  const { stdout, stderr, exitCode } = await exec(
    ['bun', 'crew/src/cli.ts', ...args],
    opts,
  );
  if (exitCode !== 0) {
    throw new Error(`crew ${args.join(' ')} failed (${exitCode}): ${stderr.trim()}`);
  }
  return stdout.trim();
}

async function capturePane(pane: string): Promise<string> {
  const { stdout } = await exec(['tmux', 'capture-pane', '-p', '-J', '-t', pane]);
  return stdout;
}

async function makePane(): Promise<string> {
  const { stdout } = await exec([
    'tmux', 'split-window', '-P', '-F', '#{pane_id}', '-t', SESSION, '-d',
  ]);
  return stdout.trim();
}

async function fireStopHook(pane: string, workerName: string, msg: string): Promise<void> {
  const payload = JSON.stringify({
    hook_event_name: 'Stop',
    session_id: `uat-${Date.now()}`,
    last_assistant_message: msg,
  });
  await exec(
    ['bun', 'crew/src/cli.ts', 'hook-event'],
    { stdin: payload, env: { TMUX_PANE: pane, CREW_STATE_DIR: join(TEST_DIR, 'state') } },
  );
}

async function waitForPaneContent(
  pane: string,
  text: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await capturePane(pane);
    if (content.includes(text)) return true;
    await Bun.sleep(300);
  }
  return false;
}

async function ensureNoContent(
  pane: string,
  text: string,
  waitMs: number,
): Promise<boolean> {
  // Poll for the duration; if the text never appears, return true (good)
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const content = await capturePane(pane);
    if (content.includes(text)) return false; // appeared — bad
    await Bun.sleep(300);
  }
  return true;
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanup() {
  console.log('\n  Cleaning up...');
  if (serverProc) {
    serverProc.kill();
    await serverProc.exited.catch(() => {});
  }
  await exec(['tmux', 'kill-session', '-t', SESSION]).catch(() => {});
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n═══ UAT: Input-Block Delivery Correctness ═══\n');

  // Setup
  await exec(['tmux', 'kill-session', '-t', SESSION]).catch(() => {});
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_DIR, 'state'), { recursive: true });

  // Start tmux session
  await exec(['tmux', 'new-session', '-d', '-s', SESSION, '-x', '220', '-y', '50']);
  const { stdout: p0 } = await exec(['tmux', 'display-message', '-p', '-t', SESSION, '#{pane_id}']);
  const basePane = p0.trim();
  assert(basePane.startsWith('%'), `Created tmux session, base pane = ${basePane}`);

  // Start crew server
  serverProc = Bun.spawn(
    ['bun', 'crew/src/cli.ts', 'server', 'start'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CREW_STATE_DIR: join(TEST_DIR, 'state') },
    },
  );
  // Give server time to boot
  await Bun.sleep(1500);

  // ─── Scenario A: block=off, delivery should happen ─────────────────────────
  console.log('\n─── Scenario A: block=off → notification MUST reach leader ───\n');

  const leaderPaneA = await makePane();
  const workerPaneA = await makePane();
  console.log(`  leader=${leaderPaneA}  worker=${workerPaneA}`);

  await crew(['join', '--room', ROOM, '--name', 'leader-a', '--role', 'leader', '--pane', leaderPaneA]);
  await crew(['join', '--room', ROOM, '--name', 'worker-a', '--role', 'worker', '--pane', workerPaneA]);

  // Confirm block is off (default) — use 'input-block status' not 'block' (block always enables)
  const statusA = await crew(['input-block', '--name', 'leader-a', 'status']).catch(() => '');
  console.log(`  block status: ${statusA || '(empty/default)'}`);
  assert(!statusA.includes('persist') && !statusA.includes('armed'), `leader-a block mode is off: ${statusA}`);

  // Fire a Stop hook from the worker
  const UNIQUE_MSG_A = `TaskDoneScenarioA-${Date.now()}`;
  await fireStopHook(workerPaneA, 'worker-a', UNIQUE_MSG_A);

  // Wait up to 10s for the leader pane to receive it
  const deliveredA = await waitForPaneContent(leaderPaneA, UNIQUE_MSG_A, 10000);
  assert(deliveredA, 'Leader pane received worker completion notification (block=off)');
  if (!deliveredA) {
    const content = await capturePane(leaderPaneA);
    console.log('  Leader pane content (tail):\n', content.split('\n').slice(-10).join('\n'));
  }

  // ─── Scenario B: block=persist, delivery should NOT happen ─────────────────
  console.log('\n─── Scenario B: block=persist → notification must NOT reach leader ───\n');

  const leaderPaneB = await makePane();
  const workerPaneB = await makePane();
  console.log(`  leader=${leaderPaneB}  worker=${workerPaneB}`);

  await crew(['join', '--room', ROOM + '-b', '--name', 'leader-b', '--role', 'leader', '--pane', leaderPaneB]);
  await crew(['join', '--room', ROOM + '-b', '--name', 'worker-b', '--role', 'worker', '--pane', workerPaneB]);

  // Activate persist block on leader
  await crew(['block', '--name', 'leader-b', '-p']);
  // Check status using input-block (not block, which would re-arm)
  const statusB = await crew(['input-block', '--name', 'leader-b', 'status']).catch(() => '');
  console.log(`  block status after -p: ${statusB}`);
  assert(statusB.includes('persist'), `leader-b block mode is persist: ${statusB}`);

  // Fire a Stop hook from the worker
  const UNIQUE_MSG_B = `TaskDoneScenarioB-${Date.now()}`;
  await fireStopHook(workerPaneB, 'worker-b', UNIQUE_MSG_B);

  // Wait up to 5s — the message must NOT appear
  const notDeliveredB = await ensureNoContent(leaderPaneB, UNIQUE_MSG_B, 5000);
  assert(notDeliveredB, 'Leader pane did NOT receive worker notification when block=persist');
  if (!notDeliveredB) {
    const content = await capturePane(leaderPaneB);
    console.log('  Leader pane content (LEAKED!):\n', content.split('\n').slice(-10).join('\n'));
  }

  // ─── Results ───────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════\n');

  await cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('\nFatal UAT error:', e);
  await cleanup();
  process.exit(1);
});
