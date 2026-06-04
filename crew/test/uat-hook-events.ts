#!/usr/bin/env bun
/**
 * UAT: Hook-driven idle detection E2E test.
 *
 * Spawns a crew server, creates a room, registers a worker on a real
 * Claude Code tmux pane, installs hooks, and verifies the full pipeline:
 *   Claude Code turn → Stop hook → crew hook-event CLI → SQLite → status/WS
 *
 * Usage:
 *   bun crew/test/uat-hook-events.ts
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendKeys } from '../src/tmux/index.ts';

const TEST_DIR = join(tmpdir(), 'crew-hook-uat');
const DB_PATH = join(TEST_DIR, 'state', 'crew.db');
const WORKER_CWD = join(TEST_DIR, 'worker-cwd');
const SESSION_NAME = 'crew-hook-uat';
const ROOM_NAME = 'uat-room';
const WORKER_NAME = 'uat-worker';

let passed = 0;
let failed = 0;
let skipped = 0;
let workerPane = '';
let serverProc: ReturnType<typeof Bun.spawn> | null = null;

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
  skipped++;
}

async function exec(
  cmd: string[],
  opts?: { stdin?: string; env?: Record<string, string>; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: opts?.stdin ? new Response(opts.stdin) : undefined,
    env: { ...process.env, CREW_STATE_DIR: join(TEST_DIR, 'state'), ...opts?.env },
  });
  const timeout = opts?.timeout ?? 15_000;
  const timer = setTimeout(() => proc.kill(), timeout);
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
  if (exitCode !== 0 && !stderr.includes('already exists')) {
    throw new Error(`crew ${args.join(' ')} failed (${exitCode}): ${stderr}`);
  }
  return stdout.trim();
}

async function capturePane(pane: string): Promise<string> {
  const proc = Bun.spawn(
    ['tmux', 'capture-pane', '-p', '-J', '-t', pane],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

function isIdle(text: string): boolean {
  const lines = text.split('\n');
  const nonEmpty = lines.filter(l => l.trim());
  const bottom = nonEmpty.slice(-15).join('\n');
  const hasPrompt = bottom.includes('❯') || bottom.includes('bypass permissions');
  const isBusy = /[·✶✽✻]\s+\w+…/.test(bottom);
  return hasPrompt && !isBusy;
}

async function waitForIdle(pane: string, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  await Bun.sleep(2000);
  while (Date.now() < deadline) {
    const text = await capturePane(pane);
    if (isIdle(text)) return true;
    await Bun.sleep(2000);
  }
  return false;
}


async function waitForClaude(pane: string, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  await Bun.sleep(2000);
  while (Date.now() < deadline) {
    try {
      const proc = Bun.spawn(["tmux", "display-message", "-p", "-t", pane, "#{pane_current_command}"], { stdout: "pipe", stderr: "pipe" });
      const cmd = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      if (cmd.toLowerCase().includes("claude")) {
        const text = await capturePane(pane);
        if (isIdle(text)) return true;
      }
    } catch {}
    await Bun.sleep(2000);
  }
  return false;
}
async function waitForDbEvent(
  eventType: string,
  afterId: number,
  timeoutMs = 60_000,
): Promise<{ id: number; agent_name: string; event_type: string; payload: string | null; created_at: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(DB_PATH)) {
      try {
        const db = new Database(DB_PATH, { readonly: true });
        const row = db
          .query(
            'SELECT * FROM hook_events WHERE event_type = ? AND id > ? ORDER BY id DESC LIMIT 1',
          )
          .get(eventType, afterId) as any;
        db.close();
        if (row) return row;
      } catch {
        // DB may be locked or not yet created
      }
    }
    await Bun.sleep(1000);
  }
  return null;
}

function getMaxEventId(): number {
  if (!existsSync(DB_PATH)) return 0;
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const row = db.query('SELECT MAX(id) as maxId FROM hook_events').get() as any;
    db.close();
    return row?.maxId ?? 0;
  } catch {
    return 0;
  }
}

function getAgentStatus(): string | null {
  if (!existsSync(DB_PATH)) return null;
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const row = db
      .query('SELECT status FROM agents WHERE name = ?')
      .get(WORKER_NAME) as any;
    db.close();
    return row?.status ?? null;
  } catch {
    return null;
  }
}

// ─── CLEANUP ───

async function cleanup() {
  console.log('\n  Cleaning up...');
  if (serverProc) {
    serverProc.kill();
    await serverProc.exited.catch(() => {});
  }
  await exec(['tmux', 'kill-session', '-t', SESSION_NAME]).catch(() => {});
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// ─── MAIN TEST FLOW ───

async function main() {
  console.log('\n═══ Hook-Driven Idle Detection E2E UAT ═══\n');

  // Cleanup any leftovers
  await exec(['tmux', 'kill-session', '-t', SESSION_NAME]).catch(() => {});
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_DIR, 'state'), { recursive: true });
  mkdirSync(WORKER_CWD, { recursive: true });

  // Write a simple test file for Claude to read
  const testFilePath = join(WORKER_CWD, 'test.js');
  Bun.write(testFilePath, 'function greet(name) { return `Hello, ${name}`; }\nmodule.exports = { greet };\n');

  // ─── Phase 1: DB table + hook-event CLI ───
  console.log('Phase 1: Hook event DB table + CLI command');

  // Create tmux session with a worker pane
  await exec(['tmux', 'new-session', '-d', '-s', SESSION_NAME, '-x', '200', '-y', '50']);
  const { stdout: paneOut } = await exec([
    'tmux', 'display-message', '-p', '-t', SESSION_NAME, '#{pane_id}',
  ]);
  workerPane = paneOut.trim();
  assert(workerPane.startsWith('%'), `Created tmux pane ${workerPane}`);

  // Register room + worker
  await crew(['join', '--room', ROOM_NAME, '--name', WORKER_NAME, '--role', 'worker', '--pane', workerPane]);
  const membersOut = await crew(['members', '--room', ROOM_NAME, '--json']);
  assert(
    membersOut.includes(WORKER_NAME),
    `Worker ${WORKER_NAME} registered in room`,
  );

  // Test hook-event CLI with synthetic payload
  const hookPayload = JSON.stringify({
    hook_event_name: 'Stop',
    session_id: 'test-session-1',
    last_assistant_message: 'UAT synthetic stop event',
  });
  await crew(['hook-event'], { stdin: hookPayload, env: { TMUX_PANE: workerPane } });

  const stopEvent = await waitForDbEvent('Stop', 0, 5000);
  assert(stopEvent !== null, 'hook-event CLI wrote Stop event to DB');
  if (stopEvent) {
    assert(stopEvent.agent_name === WORKER_NAME, `Event agent = ${WORKER_NAME}`);
    const payload = JSON.parse(stopEvent.payload!);
    assert(
      payload.last_assistant_message === 'UAT synthetic stop event',
      'Payload contains last_assistant_message',
    );
  }

  // Verify status changed to idle
  const statusAfterStop = getAgentStatus();
  assert(statusAfterStop === 'idle', `Agent status = idle after Stop event (got: ${statusAfterStop})`);

  // Send UserPromptSubmit → status should flip to busy
  const submitPayload = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'test-session-1',
    prompt: 'test prompt',
  });
  const beforeSubmitId = getMaxEventId();
  await crew(['hook-event'], { stdin: submitPayload, env: { TMUX_PANE: workerPane } });
  const submitEvent = await waitForDbEvent('UserPromptSubmit', beforeSubmitId, 5000);
  assert(submitEvent !== null, 'hook-event CLI wrote UserPromptSubmit event');

  const statusAfterSubmit = getAgentStatus();
  assert(statusAfterSubmit === 'busy', `Agent status = busy after UserPromptSubmit (got: ${statusAfterSubmit})`);

  // ─── Phase 2: Hook auto-installation ───
  console.log('\nPhase 2: Hook auto-installation');

  const { installHooks } = await import('../src/hooks/install-hooks.ts');
  await installHooks(WORKER_CWD);

  const settingsPath = join(WORKER_CWD, '.claude', 'settings.local.json');
  assert(existsSync(settingsPath), 'settings.local.json created');

  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  assert(settings.hooks?.Stop?.length > 0, 'Stop hook installed');
  assert(settings.hooks?.UserPromptSubmit?.length > 0, 'UserPromptSubmit hook installed');
  assert(
    settings.hooks.Stop[0].hooks[0].command.includes('crew hook-event'),
    'Stop hook command = "crew hook-event || true"',
  );

  // Idempotency: run again, should not duplicate
  await installHooks(WORKER_CWD);
  const settings2 = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  assert(
    settings2.hooks.Stop.length === settings.hooks.Stop.length,
    'installHooks is idempotent (no duplicate entries)',
  );

  // ─── Phase 3: pane-status hook detection ───
  console.log('\nPhase 3: Pane status via hook events');

  // We need the crew server running for DB access in getPaneStatus
  // Start the server in background
  serverProc = Bun.spawn(
    ['bun', 'crew/src/cli.ts', 'serve', '--port', '0', '--headless'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CREW_STATE_DIR: join(TEST_DIR, 'state') },
    },
  );
  await Bun.sleep(2000); // Let server start

  // Inject more Stop events to test contentChanged tracking
  const beforeStatusId = getMaxEventId();
  await crew(['hook-event'], {
    stdin: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'test-session-2',
      last_assistant_message: 'Second stop for contentChanged test',
    }),
    env: { TMUX_PANE: workerPane },
  });
  const afterStatusId = getMaxEventId();
  assert(afterStatusId > beforeStatusId, 'New Stop event written (contentChanged source)');

  // ─── Phase 5: Sweep idle detection ───
  console.log('\nPhase 5: Sweep idle detection (synthetic events)');

  // Verify sweep's view: after Stop event, agent should be idle
  const finalStatus = getAgentStatus();
  assert(finalStatus === 'idle', `Agent status after final Stop = idle (got: ${finalStatus})`);

  // ─── Phase 7: wait-for-idle ───
  console.log('\nPhase 7: wait-for-idle hook path');

  // Fire a Stop event, then check wait-for-idle resolves
  const preWaitId = getMaxEventId();
  await crew(['hook-event'], {
    stdin: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'test-session-3',
      last_assistant_message: 'wait-for-idle test',
    }),
    env: { TMUX_PANE: workerPane },
  });

  const waitResult = await exec(
    ['bun', 'crew/src/cli.ts', 'wait-idle', '--target', workerPane, '--timeout', '10000'],
    { timeout: 20_000 },
  );
  assert(waitResult.exitCode === 0, `wait-idle exits 0 (got: ${waitResult.exitCode})`);
  assert(
    waitResult.stdout.includes('idle'),
    `wait-idle output contains "idle"`,
    waitResult.stdout.slice(0, 200),
  );

  // ─── Phase 8: Real Claude Code E2E ───
  console.log('\nPhase 8: Real Claude Code E2E');

  // Check if Claude Code is available
  const { exitCode: ccCheck } = await exec(['which', 'claude']);
  if (ccCheck !== 0) {
    skip('Launch Claude Code', 'claude not in PATH');
    skip('Hook fires on Stop', 'claude not available');
    skip('last_assistant_message captured', 'claude not available');
    skip('Status transitions busy→idle', 'claude not available');
  } else {
    await exec(['tmux', 'send-keys', '-t', workerPane, 'C-c', '']);
    await Bun.sleep(500);
    await exec(['tmux', 'send-keys', '-t', workerPane, `cd ${WORKER_CWD}`, 'Enter']);
    await Bun.sleep(1000);
    // Set CREW_STATE_DIR so hooks write to our test DB
    await exec(['tmux', 'send-keys', '-t', workerPane, `export CREW_STATE_DIR=${join(TEST_DIR, 'state')}`, 'Enter']);
    await Bun.sleep(500);

    await exec(['tmux', 'send-keys', '-t', workerPane, 'claude --dangerously-skip-permissions', 'Enter']);
    await Bun.sleep(20000);

    // Wait for Claude Code to reach idle prompt (generous timeout for cold start)
    const ccReady = await waitForClaude(workerPane, 90_000);
    assert(ccReady, 'Claude Code reached idle prompt');

    if (ccReady) {
      // Claude can briefly expose the shell prompt before the full UI is actually
      // ready to accept the first pasted turn.
      await Bun.sleep(8000);

      // Record baseline event ID AFTER all synthetic phases completed
      const prePromptId = getMaxEventId();

      // Send a simple prompt via crew's sendKeys (paste-buffer + bracketed paste)
      const prompt = 'What is 2+2? Reply with ONLY the number.';
      const sendResult = await sendKeys(workerPane, prompt);
      assert(sendResult.delivered, `sendKeys delivered prompt`, sendResult.error);

      // Wait for UserPromptSubmit event
      const upsEvent = await waitForDbEvent('UserPromptSubmit', prePromptId, 30_000);
      assert(upsEvent !== null, 'UserPromptSubmit hook event fired');
      if (upsEvent) {
        const upsPayload = JSON.parse(upsEvent.payload!);
        assert(
          typeof upsPayload.prompt === 'string' && upsPayload.prompt.length > 0,
          'UserPromptSubmit has prompt text',
        );

        // Agent should be busy now
        const busyStatus = getAgentStatus();
        assert(busyStatus === 'busy', `Status = busy after UserPromptSubmit (got: ${busyStatus})`);
      }

      // Wait for Stop event (Claude responds) — use prePromptId as baseline
      const stopEvt = await waitForDbEvent('Stop', prePromptId, 60_000);
      assert(stopEvt !== null, 'Stop hook event fired after Claude response');
      if (stopEvt) {
        const stopPayload = JSON.parse(stopEvt.payload!);
        assert(
          typeof stopPayload.last_assistant_message === 'string' &&
            stopPayload.last_assistant_message.length > 0,
          'Stop event has last_assistant_message',
        );
        assert(
          stopPayload.last_assistant_message.includes('4'),
          `Claude answered "4" in last_assistant_message`,
          `Got: ${stopPayload.last_assistant_message.slice(0, 100)}`,
        );

        // Agent should be idle now
        const idleStatus = getAgentStatus();
        assert(idleStatus === 'idle', `Status = idle after Stop (got: ${idleStatus})`);
      }

      // ── Second turn: test the full cycle again ──
      console.log('\nPhase 8b: Second turn lifecycle');

      // Wait for Claude to be back at idle prompt
      await waitForIdle(workerPane, 30_000);
      const preSecondId = getMaxEventId();

      const prompt2 = 'What is the capital of France? Reply with ONLY the city name.';
      const sendResult2 = await sendKeys(workerPane, prompt2);
      assert(sendResult2.delivered, `sendKeys delivered second prompt`, sendResult2.error);

      const ups2 = await waitForDbEvent('UserPromptSubmit', preSecondId, 30_000);
      assert(ups2 !== null, 'Second UserPromptSubmit fired');

      const stop2 = await waitForDbEvent('Stop', preSecondId, 60_000);
      assert(stop2 !== null, 'Second Stop event fired');
      if (stop2) {
        const p2 = JSON.parse(stop2.payload!);
        assert(
          p2.last_assistant_message?.toLowerCase().includes('paris'),
          'Claude answered "Paris"',
          `Got: ${p2.last_assistant_message?.slice(0, 100)}`,
        );
      }

      // ── Verify DB integrity ──
      console.log('\nPhase 8c: DB integrity');
      const db = new Database(DB_PATH, { readonly: true });
      const allEvents = db.query('SELECT * FROM hook_events ORDER BY id').all() as any[];
      db.close();

      assert(allEvents.length >= 4, `Total hook events >= 4 (got: ${allEvents.length})`);
      const stopCount = allEvents.filter((e: any) => e.event_type === 'Stop').length;
      const submitCount = allEvents.filter((e: any) => e.event_type === 'UserPromptSubmit').length;
      assert(stopCount >= 2, `Stop events >= 2 (got: ${stopCount})`);
      assert(submitCount >= 2, `UserPromptSubmit events >= 2 (got: ${submitCount})`);

      // Verify UTC timestamps
      for (const evt of allEvents.slice(-4)) {
        const ts = new Date(evt.created_at + 'Z');
        const ageMs = Date.now() - ts.getTime();
        assert(
          ageMs >= 0 && ageMs < 300_000,
          `Event #${evt.id} timestamp within 5min window (age: ${Math.round(ageMs / 1000)}s)`,
        );
      }

      // Exit Claude Code
      await exec(['tmux', 'send-keys', '-t', workerPane, '/exit', 'Enter']);
      await Bun.sleep(2000);
    }
  }

  // ─── Summary ───
  console.log(`\n═══ Results: ${passed} passed, ${failed} failed, ${skipped} skipped ═══\n`);

  await cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`\nFATAL: ${e instanceof Error ? e.message : String(e)}`);
  await cleanup();
  process.exit(2);
});
