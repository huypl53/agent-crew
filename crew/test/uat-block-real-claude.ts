#!/usr/bin/env bun
/**
 * UAT: Block delivery with real Claude Code agents.
 *
 * Spawns two real Claude Code instances in tmux panes:
 *   - leader pane: receives (or doesn't receive) notifications
 *   - worker pane: runs Claude, completes a task, fires real Stop hook
 *
 * Scenario A (block=off):
 *   Worker Claude completes a task → Stop hook fires → leader pane gets notification ✓
 *
 * Scenario B (block=persist):
 *   Worker Claude completes a task → Stop hook fires → leader pane gets nothing ✓
 *
 * Prerequisites:
 *   - `claude` must be in PATH
 *   - ANTHROPIC_API_KEY or equivalent must be set
 *
 * Usage:
 *   bun crew/test/uat-block-real-claude.ts
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DIR = join(tmpdir(), 'crew-block-real-claude-uat');
const DB_PATH = join(TEST_DIR, 'state', 'crew.db');
const SESSION = 'crew-block-real-uat';
const ROOM_A = 'block-real-room-a';
const ROOM_B = 'block-real-room-b';

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
  return ok;
}

function skip(label: string, reason: string) {
  console.log(`  ○ ${label} — SKIPPED: ${reason}`);
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
  const timer = setTimeout(() => proc.kill(), opts?.timeout ?? 15_000);
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

async function tmuxSend(pane: string, keys: string): Promise<void> {
  // Send text literally then submit with Enter — matches pattern from uat-hook-events.ts
  await exec(['tmux', 'send-keys', '-t', pane, keys, 'Enter']);
}

async function capturePane(pane: string): Promise<string> {
  const { stdout } = await exec(['tmux', 'capture-pane', '-p', '-J', '-t', pane, '-S', '-300']);
  return stdout;
}

function isClaudeIdle(text: string): boolean {
  const lines = text.split('\n');
  const bottom = lines.slice(-15).join('\n');
  // Claude Code shows ❯ prompt, or 'bypass permissions' text, or its input box border ╰─
  const hasPrompt =
    bottom.includes('❯') ||
    bottom.includes('bypass permissions') ||
    bottom.includes('╰─') ||
    bottom.includes('\u256f'); // ╯ right corner
  const isBusy = /[·✶✽✻✿]\s+\w+…/.test(bottom);
  return hasPrompt && !isBusy;
}

async function waitForClaudeIdle(pane: string, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  await Bun.sleep(3000);
  while (Date.now() < deadline) {
    const text = await capturePane(pane);
    if (isClaudeIdle(text)) return true;
    await Bun.sleep(2000);
  }
  return false;
}

function getMaxEventId(): number {
  if (!existsSync(DB_PATH)) return 0;
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const row = db.query('SELECT MAX(id) as maxId FROM hook_events').get() as { maxId: number | null } | null;
    db.close();
    return row?.maxId ?? 0;
  } catch {
    return 0;
  }
}

async function waitForDbEvent(
  eventType: string,
  afterId: number,
  timeoutMs = 90_000,
): Promise<{ id: number; agent_name: string; payload: string | null } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(DB_PATH)) {
      try {
        const db = new Database(DB_PATH, { readonly: true });
        const row = db
          .query('SELECT * FROM hook_events WHERE event_type = ? AND id > ? ORDER BY id DESC LIMIT 1')
          .get(eventType, afterId) as { id: number; agent_name: string; payload: string | null } | null;
        db.close();
        if (row) return row;
      } catch {
        // DB may be locked — retry
      }
    }
    await Bun.sleep(1000);
  }
  return null;
}

async function spawnClaudeInPane(pane: string, workDir: string): Promise<boolean> {
  // Each send-keys call includes 'Enter' — give shell time to process each command
  await tmuxSend(pane, `cd ${workDir}`);
  await Bun.sleep(500);
  await tmuxSend(pane, `export CREW_STATE_DIR=${join(TEST_DIR, 'state')}`);
  await Bun.sleep(500);
  await tmuxSend(pane, 'claude --dangerously-skip-permissions');
  // Give Claude time to start its UI before we begin polling
  await Bun.sleep(5000);
  return waitForClaudeIdle(pane, 90_000);
}

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
  console.log('\n═══ UAT: Block Delivery with Real Claude Code Agents ═══\n');

  // Check claude is available
  const { exitCode: claudeCheck } = await exec(['which', 'claude']);
  if (claudeCheck !== 0) {
    console.error('ERROR: `claude` not found in PATH. This UAT requires real Claude Code.');
    process.exit(1);
  }

  // Setup dirs
  await exec(['tmux', 'kill-session', '-t', SESSION]).catch(() => {});
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });

  const stateDir = join(TEST_DIR, 'state');
  const workDirA = join(TEST_DIR, 'work-a');
  const workDirB = join(TEST_DIR, 'work-b');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workDirA, { recursive: true });
  mkdirSync(workDirB, { recursive: true });

  // Write simple files for Claude to read (keeps tasks short/deterministic)
  await Bun.write(join(workDirA, 'task.txt'), 'What is 3+3? Reply with ONLY: "DONE-A: <number>"');
  await Bun.write(join(workDirB, 'task.txt'), 'What is 4+4? Reply with ONLY: "DONE-B: <number>"');

  // Create tmux session with enough panes
  await exec(['tmux', 'new-session', '-d', '-s', SESSION, '-x', '220', '-y', '50']);
  const { stdout: p0raw } = await exec(['tmux', 'display-message', '-p', '-t', SESSION, '#{pane_id}']);
  const pane0 = p0raw.trim(); // utility pane

  // Create 4 panes: leaderA, workerA, leaderB, workerB
  const { stdout: paLeaderA } = await exec(['tmux', 'split-window', '-P', '-F', '#{pane_id}', '-t', SESSION, '-d', '-h']);
  const leaderPaneA = paLeaderA.trim();
  const { stdout: paWorkerA } = await exec(['tmux', 'split-window', '-P', '-F', '#{pane_id}', '-t', SESSION, '-d']);
  const workerPaneA = paWorkerA.trim();
  const { stdout: paLeaderB } = await exec(['tmux', 'split-window', '-P', '-F', '#{pane_id}', '-t', pane0, '-d']);
  const leaderPaneB = paLeaderB.trim();
  const { stdout: paWorkerB } = await exec(['tmux', 'split-window', '-P', '-F', '#{pane_id}', '-t', paLeaderB.trim(), '-d']);
  const workerPaneB = paWorkerB.trim();

  console.log(`Panes — leaderA:${leaderPaneA}  workerA:${workerPaneA}  leaderB:${leaderPaneB}  workerB:${workerPaneB}`);

  // Start crew server (sweep loop lives inside 'serve')
  serverProc = Bun.spawn(
    ['bun', 'crew/src/cli.ts', 'serve', '--headless'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CREW_STATE_DIR: stateDir },
      cwd: '/home/vtit/code/utils/agent-crew',
    },
  );
  await Bun.sleep(2500);
  console.log('Crew server started (sweep loop active).\n');

  // Install hooks in both workdirs so Claude fires crew hook-event on Stop
  const { installHooks } = await import('../src/hooks/install-hooks.ts');
  await installHooks(workDirA);
  await installHooks(workDirB);
  console.log('Hooks installed in work dirs.\n');

  // ─── Spawn Claude in both worker panes ────────────────────────────────────
  console.log('Spawning Claude Code in worker panes (this may take ~30–90s per pane)...');

  const readyA = await spawnClaudeInPane(workerPaneA, workDirA);
  if (!assert(readyA, 'Claude Code (worker-A) reached idle prompt')) {
    const t = await capturePane(workerPaneA);
    console.log('  Pane content:\n', t.split('\n').slice(-12).join('\n'));
  }

  const readyB = await spawnClaudeInPane(workerPaneB, workDirB);
  if (!assert(readyB, 'Claude Code (worker-B) reached idle prompt')) {
    const t = await capturePane(workerPaneB);
    console.log('  Pane content:\n', t.split('\n').slice(-12).join('\n'));
  }

  if (!readyA || !readyB) {
    console.log('\nCannot continue — Claude failed to start in one or more panes.');
    await cleanup();
    process.exit(1);
  }

  // Extra settle time after Claude UI appears but before first send
  await Bun.sleep(5000);

  // Cd leader panes to workdirs so they share the same directory CWD as their workers (and hence join the same rooms)
  await tmuxSend(leaderPaneA, `cd ${workDirA}`);
  await Bun.sleep(500);
  await tmuxSend(leaderPaneA, `export CREW_STATE_DIR=${stateDir}`);
  await Bun.sleep(500);

  await tmuxSend(leaderPaneB, `cd ${workDirB}`);
  await Bun.sleep(500);
  await tmuxSend(leaderPaneB, `export CREW_STATE_DIR=${stateDir}`);
  await Bun.sleep(500);

  // Register agents in crew
  await crew(['join', '--room', ROOM_A, '--name', 'leader-a', '--role', 'leader', '--pane', leaderPaneA]);
  await crew(['join', '--room', ROOM_A, '--name', 'worker-a', '--role', 'worker', '--pane', workerPaneA]);
  await crew(['join', '--room', ROOM_B, '--name', 'leader-b', '--role', 'leader', '--pane', leaderPaneB]);
  await crew(['join', '--room', ROOM_B, '--name', 'worker-b', '--role', 'worker', '--pane', workerPaneB]);
  console.log('\nAgents registered.\n');

  // ─── Scenario A: block=off, leader MUST receive the notification ──────────
  console.log('─── Scenario A: block=off → leader MUST receive completion notification ───\n');

  const blockStatusA = await crew(['input-block', '--name', 'leader-a', 'status']).catch(() => '');
  assert(!blockStatusA.includes('persist') && !blockStatusA.includes('armed'),
    `leader-a block=off: ${blockStatusA}`);

  const preIdA = getMaxEventId();
  // Send a simple prompt — Claude will complete it and fire the Stop hook
  const { sendKeys } = await import('../src/tmux/index.ts');
  const sendResultA = await sendKeys(workerPaneA, 'Read task.txt and follow its instructions exactly.');
  assert(sendResultA.delivered, 'sendKeys delivered prompt to worker-A');

  // Wait for Stop hook event from worker-a
  console.log('  Waiting for worker-a Stop hook event (up to 120s)...');
  const stopEventA = await waitForDbEvent('Stop', preIdA, 120_000);
  assert(stopEventA !== null, 'Stop hook fired for worker-a');
  if (stopEventA) {
    assert(stopEventA.agent_name === 'worker-a', `Stop event agent = worker-a (got: ${stopEventA.agent_name})`);
  }

  // Wait for leader pane to receive the notification.
  // The sweep loop runs every 5s and notifies after IDLE_THRESHOLD_MS (1min) of idle.
  // Wait up to 90s to cover the full cycle.
  console.log('  Waiting for leader-a pane to receive notification (up to 90s via sweep)...');
  const deadline = Date.now() + 90_000;
  let leaderGotIt = false;
  while (Date.now() < deadline) {
    const content = await capturePane(leaderPaneA);
    if (content.includes('worker-a') || content.includes('DONE-A') || content.includes('completed')
        || content.includes('idle') || content.includes('system@')) {
      leaderGotIt = true;
      break;
    }
    await Bun.sleep(2000);
  }
  assert(leaderGotIt, 'Leader-A pane received worker completion notification (block=off)');

  // Always dump leader pane full content and server stderr for diagnosis
  const leaderContent = await capturePane(leaderPaneA);
  console.log(`  Leader-A pane (full capture ${leaderPaneA}):\n${leaderContent.split('\n').filter(l => l.trim()).slice(-20).join('\n') || '  (empty)'}`);

  // Read server log to see sweep logs
  const logPath = join(stateDir, 'server.log');
  if (existsSync(logPath)) {
    const serverLog = await Bun.file(logPath).text();
    const sweepLines = serverLog.split('\n').filter(l => l.includes('SWEEP') || l.includes('flush') || l.includes('defer') || l.includes('WARN') || l.includes('START'));
    console.log(`  Server sweep logs (last 20):\n${sweepLines.slice(-20).join('\n') || '  (none)'}`);
  }


  // ─── Scenario B: block=persist, leader must NOT receive anything ──────────
  console.log('\n─── Scenario B: block=persist → leader must NOT receive notification ───\n');

  await crew(['block', '--name', 'leader-b', '-p']);
  const blockStatusB = await crew(['input-block', '--name', 'leader-b', 'status']).catch(() => '');
  assert(blockStatusB.includes('persist'), `leader-b block=persist: ${blockStatusB}`);

  const preIdB = getMaxEventId();
  const sendResultB = await sendKeys(workerPaneB, 'Read task.txt and follow its instructions exactly.');
  assert(sendResultB.delivered, 'sendKeys delivered prompt to worker-B');

  // Wait for Stop hook from worker-b
  console.log('  Waiting for worker-b Stop hook event (up to 120s)...');
  const stopEventB = await waitForDbEvent('Stop', preIdB, 120_000);
  assert(stopEventB !== null, 'Stop hook fired for worker-b');
  if (stopEventB) {
    assert(stopEventB.agent_name === 'worker-b', `Stop event agent = worker-b (got: ${stopEventB.agent_name})`);
  }

  // Capture baseline leader-B content right after Stop
  const leaderBBefore = await capturePane(leaderPaneB);

  // Wait 10s — nothing should appear in leader-B pane
  console.log('  Waiting 10s to confirm NO notification delivered to leader-B...');
  await Bun.sleep(10_000);
  const leaderBAfter = await capturePane(leaderPaneB);

  // Check that no crew notification appeared (new content referencing worker-b/DONE-B)
  const newContent = leaderBAfter.replace(leaderBBefore, '').trim();
  const leaked = newContent.includes('worker-b') || newContent.includes('DONE-B') || newContent.includes('completed');
  assert(!leaked, 'Leader-B pane did NOT receive notification when block=persist');
  if (leaked) {
    console.log('  Leaked content:\n', newContent.split('\n').slice(-8).join('\n'));
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
