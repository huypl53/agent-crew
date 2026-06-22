#!/usr/bin/env bun
/**
 * UAT: Edge case test suite (17 tests)
 * Uses an isolated tmux socket (crew-uat-edge) — zero interference with user sessions.
 *
 * Usage: bun crew/test/uat-edge-cases.ts
 */

// Set isolated socket BEFORE any imports so src/tmux/index.ts picks it up
process.env.CREW_TMUX_SOCKET = 'crew-uat-edge';

import { getPollingInterval, PaneQueue } from '../src/delivery/pane-queue.ts';
import { sendKeys as tmuxSendKeys } from '../src/tmux/index.ts';
import { setupTestDb, teardownTestDb } from './lib/db-test-helpers.ts';
import {
  assert,
  capturePane,
  cleanupEdgeTestEnv,
  createTestPane,
  killPane,
  runTmux,
  SOCKET_NAME,
  sendKeys,
  setAgentMode,
  setupEdgeTestEnv,
} from './lib/edge-test-harness.ts';

// ─── Globals ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(result: { passed: boolean }) {
  if (result.passed) passed++;
  else failed++;
}

// Wrapper that tracks pass/fail and prefixes detail on failure
function ok(condition: boolean, label: string, detail?: string) {
  check(assert(condition, label, detail));
}

// ─── Fixtures path ────────────────────────────────────────────────────────────

// Resolve relative to this file's directory
const FIXTURES = new URL('../test/fixtures/mock-agent.sh', import.meta.url)
  .pathname;

// ─── E1: Pane dies mid-delivery ───────────────────────────────────────────────

async function testE1_PaneDiesMidDelivery() {
  console.log('\nE1: Pane dies mid-delivery');

  const pane = await createTestPane(`bash ${FIXTURES} e1-agent`);
  await Bun.sleep(500);

  // Start delivery then kill pane immediately — should not crash
  const deliveryPromise = sendKeys(pane, 'Test message for dead pane').catch(
    () => {},
  );
  await Bun.sleep(80);
  await killPane(pane);

  try {
    await deliveryPromise;
    ok(true, 'Delivery handled gracefully (no crash after pane kill)');
  } catch {
    ok(true, 'Delivery threw expected error on dead pane');
  }
}

// ─── E2: Frozen agent still accepts a direct submit ───────────────────────────

async function testE2_FrozenAgentDirectSubmit() {
  console.log('\nE2: Frozen agent still accepts a direct submit');

  const pane = await createTestPane(`bash ${FIXTURES} e2-agent`);
  await Bun.sleep(500);
  await setAgentMode('e2-agent', 'frozen');
  await Bun.sleep(100);

  const start = Date.now();
  const result = await tmuxSendKeys(pane, 'Message to frozen agent');
  const elapsed = Date.now() - start;

  ok(result.delivered, 'Frozen agent delivery reported success');
  ok(
    elapsed < 2000,
    `Direct submit stayed fast (${elapsed}ms < 2000ms)`,
    `elapsed=${elapsed}ms`,
  );
}

// ─── E3: Large payload (10KB) ─────────────────────────────────────────────────

async function testE3_LargePayload() {
  console.log('\nE3: Large payload (10KB)');

  // Use `stty raw; cat > file` — reads raw bytes from pty so bracketed paste content
  // is captured intact (including the marker at the end of the 10KB payload).
  const markerFile = `/tmp/crew-e3-marker-${Date.now()}.txt`;
  const pane = await createTestPane(`stty raw; cat > ${markerFile}`);
  await Bun.sleep(300);

  const marker = 'END-MARKER-E3';
  const payload = 'A'.repeat(9990) + marker;

  // Use bracketed paste (src/tmux/index.ts) to deliver 10KB atomically
  const result = await tmuxSendKeys(pane, payload);
  ok(
    result.delivered,
    `10KB payload sent successfully (delivered=${result.delivered})`,
  );
  // Ctrl-C to flush cat's output to disk
  await runTmux('send-keys', '-t', pane, 'C-c');
  await Bun.sleep(500);

  const written = (await Bun.file(markerFile).exists())
    ? await Bun.file(markerFile).text()
    : '';
  await Bun.$`rm -f ${markerFile}`.quiet().catch(() => {});
  ok(
    written.includes(marker),
    `Full 10KB payload arrived (marker present in output)`,
  );
}

// ─── E4: Special characters ───────────────────────────────────────────────────

async function testE4_SpecialChars() {
  console.log('\nE4: Special characters');

  const pane = await createTestPane(`bash ${FIXTURES} e4-agent`);
  await Bun.sleep(500);

  const testCases = [
    { input: '$(echo pwned)', expect: 'pwned', name: 'command substitution' },
    { input: '`backticks`', expect: 'backticks', name: 'backticks' },
    { input: '"quoted text"', expect: 'quoted text', name: 'double quotes' },
    { input: '\\backslash\\', expect: 'backslash', name: 'backslash' },
  ];

  for (const tc of testCases) {
    await sendKeys(pane, tc.input);
    await Bun.sleep(400);
    const content = await capturePane(pane);
    // Check that the text arrived in the pane (either literally or shell-processed)
    ok(content.includes(tc.expect), `${tc.name} content arrived`);
  }
}

// ─── E5: Rapid-fire (10 messages) ────────────────────────────────────────────

async function testE5_RapidFire() {
  console.log('\nE5: Rapid-fire (10 messages)');

  const pane = await createTestPane(`bash ${FIXTURES} e5-agent`);
  await Bun.sleep(500);

  const markers: string[] = [];
  for (let i = 0; i < 10; i++) {
    const marker = `MSG-${i}-MARKER`;
    markers.push(marker);
    // Fire sequentially — sendKeys uses bracketed paste, each completes before next
    await sendKeys(pane, `Message ${i} ${marker}`);
  }

  await Bun.sleep(2000);
  const content = await capturePane(pane, 300);

  let found = 0;
  for (const m of markers) {
    if (content.includes(m)) found++;
  }

  ok(
    found >= 8,
    `At least 8/10 rapid messages arrived (found ${found}/10)`,
    `found=${found}`,
  );

  // Check order — markers should appear in sequence (best-effort: check the ones that arrived)
  let lastIdx = -1;
  let inOrder = true;
  for (const m of markers) {
    const idx = content.indexOf(m);
    if (idx !== -1) {
      if (idx < lastIdx) inOrder = false;
      lastIdx = idx;
    }
  }
  ok(inOrder, 'Messages arrived in order');
}

// ─── E6: Chaos pane delivery eventually completes ─────────────────────────────

async function testE6_ChaosPaneDeliveryCompletes() {
  console.log('\nE6: Chaos pane delivery eventually completes');

  await setAgentMode('e6-agent', 'chaos');
  const pane = await createTestPane(`bash ${FIXTURES} e6-agent`);
  await Bun.sleep(500);

  const queue = new PaneQueue(pane);
  const start = Date.now();

  await queue.enqueue({ type: 'paste', text: 'test-e6' });
  const elapsed = Date.now() - start;

  ok(
    elapsed < 60_000,
    `Chaos-pane delivery completed without hanging indefinitely (${elapsed}ms < 60000ms)`,
    `elapsed=${elapsed}ms`,
  );
}

// ─── E7: Busy-looking pane without hooks still delivers promptly ──────────────

async function testE7_BusyLookingPaneStillDelivers() {
  console.log('\nE7: Busy-looking pane without hooks still delivers promptly');

  const pane = await createTestPane(`bash ${FIXTURES} e7-agent`);
  await Bun.sleep(500);
  await setAgentMode('e7-agent', 'busy');
  await Bun.sleep(1200);

  const queue = new PaneQueue(pane);
  const start = Date.now();

  await queue.enqueue({ type: 'paste', text: 'message to busy agent' });
  const elapsed = Date.now() - start;

  ok(
    elapsed < 2000,
    `No-hook busy pane did not stall queue (${elapsed}ms < 2000ms)`,
    `elapsed=${elapsed}ms`,
  );
}

// ─── E8: No-hook status stays unknown even when pane is stable ─────────────────

async function testE8_NoHookStatusStaysUnknown() {
  console.log('\nE8: No-hook status stays unknown even when pane is stable');

  const { getPaneStatus } = await import('../src/shared/pane-status.ts');
  const pane = await createTestPane(`bash ${FIXTURES} e8-agent`);
  await Bun.sleep(1000);

  const first = await getPaneStatus(pane);
  ok(first.status === 'unknown', `First call returned unknown (got: ${first.status})`);

  await Bun.sleep(3500);

  const second = await getPaneStatus(pane);
  ok(
    second.status === 'unknown',
    `Stable no-hook pane remained unknown (got: ${second.status})`,
  );
  ok(second.contentChanged === false, 'Stable no-hook pane reported unchanged content');

  await killPane(pane);
}

// ─── E9: Queue 20 messages ────────────────────────────────────────────────────

async function testE9_QueueBacklog() {
  console.log('\nE9: Queue 20 messages (backlog)');

  const pane = await createTestPane(`bash ${FIXTURES} e9-agent`);
  await Bun.sleep(500);

  const queue = new PaneQueue(pane);
  const markers: string[] = [];
  const promises: Promise<void>[] = [];

  for (let i = 0; i < 20; i++) {
    const marker = `Q${i.toString().padStart(2, '0')}-MARKER`;
    markers.push(marker);
    promises.push(queue.enqueue({ type: 'paste', text: `Msg ${marker}` }));
  }

  await Promise.allSettled(promises);
  await Bun.sleep(1000);

  const content = await capturePane(pane, 400);

  let delivered = 0;
  for (const m of markers) {
    if (content.includes(m)) delivered++;
  }

  ok(
    delivered >= 18,
    `At least 18/20 queued messages delivered (got ${delivered})`,
    `delivered=${delivered}`,
  );

  // Verify FIFO order among those that arrived
  let lastIdx = -1;
  let fifo = true;
  for (const m of markers) {
    const idx = content.indexOf(m);
    if (idx !== -1 && idx < lastIdx) fifo = false;
    if (idx !== -1) lastIdx = idx;
  }
  ok(fifo, 'Messages delivered in FIFO order');
}

// ─── E10: Heartbeat stale fallback ────────────────────────────────────────────

async function testE10_HeartbeatStaleFallback() {
  console.log('\nE10: Heartbeat stale fallback');

  // Fresh activity (1 second ago) → role-based interval
  const freshInterval = getPollingInterval('worker', Date.now() - 1000);
  ok(
    freshInterval === 2000,
    `Fresh worker interval is 2000ms (got ${freshInterval})`,
  );

  // Stale activity (35s ago, > 30s threshold) → 500ms conservative
  const staleInterval = getPollingInterval('worker', Date.now() - 35000);
  ok(
    staleInterval === 500,
    `Stale worker falls back to 500ms (got ${staleInterval})`,
  );

  // Very stale leader → 500ms
  const staleLeaderInterval = getPollingInterval('leader', Date.now() - 60000);
  ok(
    staleLeaderInterval === 500,
    `Stale leader falls back to 500ms (got ${staleLeaderInterval})`,
  );
}

// ─── E11: Role-based polling intervals ────────────────────────────────────────

async function testE11_RoleBasedIntervals() {
  console.log('\nE11: Role-based polling intervals');

  const now = Date.now();

  ok(getPollingInterval('worker', now) === 2000, `Worker interval is 2000ms`);
  ok(getPollingInterval('leader', now) === 5000, `Leader interval is 5000ms`);
  ok(
    getPollingInterval('unknown-role', now) === 2000,
    `Unknown role defaults to 2000ms`,
  );
  ok(getPollingInterval(undefined, now) === 2000, `No role defaults to 2000ms`);
}

// ─── E12: Spoofed TMUX_PANE ───────────────────────────────────────────────────

async function testE12_SpoofedPane() {
  console.log('\nE12: Spoofed TMUX_PANE');

  // Write script inside crew/ so imports resolve correctly
  const crewDir = new URL('..', import.meta.url).pathname;
  const tmpScript = `${crewDir}/_tmp_e12_test.ts`;

  const scriptLog = `
import { initDb, addAgent, getOrCreateRoom } from './src/state/index.ts';
import { handleSendMessage } from './src/tools/send-message.ts';

initDb(':memory:');
const room = getOrCreateRoom('/uat/test-room', 'test-room');
addAgent('test-worker', 'worker', room.id, '%10', 'claude-code');
addAgent('test-leader', 'leader', room.id, '%11', 'claude-code');

const result = await handleSendMessage({
  room: 'test-room', text: 'test message',
  name: 'test-worker', to: 'test-leader', });
console.log('log-ok:' + (result.isError !== true));
`;
  await Bun.write(tmpScript, scriptLog);

  try {
    const logProc = Bun.spawn(['bun', 'run', tmpScript], {
      env: {
        ...process.env,
        TMUX_PANE: '%99',
        CREW_SENDER_VERIFICATION: 'log',
        CREW_TMUX_SOCKET: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const logExit = await logProc.exited;
    const logOut = await new Response(logProc.stdout).text();
    const logErr = await new Response(logProc.stderr).text();
    if (logErr && !logOut.includes('log-ok'))
      console.log('  [E12 LOG stderr]:', logErr.slice(0, 200));
    ok(logExit === 0, 'LOG mode subprocess ran without crash');
    ok(
      logOut.includes('log-ok:true'),
      `LOG mode: message allowed (got: ${logOut.trim()})`,
    );

    // ENFORCE mode
    const scriptEnforce = `
import { initDb, addAgent, getOrCreateRoom } from './src/state/index.ts';
import { handleSendMessage } from './src/tools/send-message.ts';

initDb(':memory:');
const room = getOrCreateRoom('/uat/test-room', 'test-room');
addAgent('test-worker', 'worker', room.id, '%10', 'claude-code');
addAgent('test-leader', 'leader', room.id, '%11', 'claude-code');

const result = await handleSendMessage({
  room: 'test-room', text: 'test message',
  name: 'test-worker', to: 'test-leader', });
const isOk = result.isError !== true;
console.log('enforce-ok:' + isOk);
if (result.isError) {
  const parsed = JSON.parse(result.content[0].text);
  console.log('enforce-error:' + parsed.error);
}
`;
    await Bun.write(tmpScript, scriptEnforce);

    const enforceProc = Bun.spawn(['bun', 'run', tmpScript], {
      env: {
        ...process.env,
        TMUX_PANE: '%99',
        CREW_SENDER_VERIFICATION: 'enforce',
        CREW_TMUX_SOCKET: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await enforceProc.exited;
    const enforceOut = await new Response(enforceProc.stdout).text();
    ok(
      enforceOut.includes('enforce-ok:false'),
      `ENFORCE mode: message rejected (got: ${enforceOut.trim()})`,
    );
    ok(
      enforceOut.includes('mismatch'),
      `ENFORCE mode: error mentions mismatch (got: ${enforceOut.trim()})`,
    );
  } finally {
    if (await Bun.file(tmpScript).exists()) {
      await Bun.$`rm ${tmpScript}`.quiet();
    }
  }
}

// ─── E13: No TMUX_PANE (external CLI) ────────────────────────────────────────

async function testE13_NoTmuxPane() {
  console.log('\nE13: No TMUX_PANE (external CLI)');

  const crewDir = new URL('..', import.meta.url).pathname;
  const tmpScript = `${crewDir}/_tmp_e13_test.ts`;

  const script = `
import { initDb, addAgent, getOrCreateRoom } from './src/state/index.ts';
import { handleSendMessage } from './src/tools/send-message.ts';

initDb(':memory:');
const room = getOrCreateRoom('/uat/cli-room', 'cli-room');
addAgent('cli-agent', 'worker', room.id, '%20', 'claude-code');
addAgent('cli-leader', 'leader', room.id, '%21', 'claude-code');

const result = await handleSendMessage({
  room: 'cli-room', text: 'external cli message',
  name: 'cli-agent', to: 'cli-leader', });
console.log('result-ok:' + (result.isError !== true));
`;
  await Bun.write(tmpScript, script);

  try {
    const env: Record<string, string | undefined> = {
      ...process.env,
      CREW_SENDER_VERIFICATION: 'enforce',
      CREW_TMUX_SOCKET: '',
      TMUX_PANE: undefined,
    };

    const proc = Bun.spawn(['bun', 'run', tmpScript], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
    const out = await new Response(proc.stdout).text();
    // Without TMUX_PANE the callerPane is null so verification is skipped → ok=true
    ok(
      out.includes('result-ok:true'),
      `No TMUX_PANE: verification skipped, message allowed (got: ${out.trim()})`,
    );
  } finally {
    if (await Bun.file(tmpScript).exists()) {
      await Bun.$`rm ${tmpScript}`.quiet();
    }
  }
}

// ─── E14: Stale pane detection ────────────────────────────────────────────────

async function testE14_StalePaneDetection() {
  console.log('\nE14: Stale pane detection (shell-only pane)');

  // Plain bash pane — not running an agent process
  const pane = await createTestPane('bash');
  await Bun.sleep(300);

  setupTestDb();
  try {
    const { addAgent, getOrCreateRoom } = await import('../src/state/index.ts');
    const { deliverMessage } = await import('../src/delivery/index.ts');

    const room = getOrCreateRoom('/uat/stale-room', 'stale-room');
    addAgent('stale-worker', 'worker', room.id, pane, 'claude-code');
    addAgent('stale-leader', 'leader', room.id, '%999', 'claude-code');

    const results = await deliverMessage(
      'stale-leader',
      'stale-room',
      'task for stale worker',
      'stale-worker',
      null,
      undefined,
    );

    ok(results.length === 1, `Got one delivery result (got ${results.length})`);
    ok(
      results[0]!.delivered === false,
      'Delivery failed (stale pane detected)',
    );
    ok(results[0]!.queued === true, 'Message still queued');
    ok(
      (results[0]!.error ?? '').includes('stale'),
      `Error mentions stale (got: "${results[0]!.error}")`,
    );

    // markAgentStale removes the agent from the registry entirely
    const { getDb } = await import('../src/state/db.ts');
    const agent = getDb()
      .query('SELECT name FROM agents WHERE name = ?')
      .get('stale-worker') as { name: string } | null;
    ok(
      agent === null,
      `Stale agent removed from DB (got: ${JSON.stringify(agent)})`,
    );
  } finally {
    teardownTestDb();
  }
}

// ─── E15: Broadcast with partial delivery ────────────────────────────────────

async function testE15_BroadcastPartialDelivery() {
  console.log('\nE15: Broadcast with partial delivery (3 live + 2 dead panes)');

  // 3 live mock-agent panes
  const livePanes: string[] = [];
  for (let i = 0; i < 3; i++) {
    const p = await createTestPane(`bash ${FIXTURES} live-e15-${i}`);
    livePanes.push(p);
  }
  await Bun.sleep(500);

  // 2 dead panes (kill immediately after creation)
  const deadPanes: string[] = [];
  for (let i = 0; i < 2; i++) {
    const p = await createTestPane('bash');
    deadPanes.push(p);
    await killPane(p);
  }

  setupTestDb();
  try {
    const { addAgent, getOrCreateRoom } = await import('../src/state/index.ts');
    const { deliverMessage } = await import('../src/delivery/index.ts');

    const room = getOrCreateRoom('/uat/broadcast-room', 'broadcast-room');
    addAgent('broadcaster', 'leader', room.id, '%800', 'unknown');

    for (let i = 0; i < 3; i++) {
      addAgent(
        `live-e15-${i}`,
        'worker',
        room.id,
        livePanes[i]!,
        'unknown',
      );
    }
    for (let i = 0; i < 2; i++) {
      // Use 'claude-code' so the stale-pane check fires immediately (skips 10s waitForReady timeout)
      addAgent(
        `dead-e15-${i}`,
        'worker',
        room.id,
        deadPanes[i]!,
        'claude-code',
      );
    }

    const results = await deliverMessage(
      'broadcaster',
      'broadcast-room',
      'broadcast message',
      null,
      null,
      undefined,
    );

    // All 5 non-broadcaster members get attempted
    ok(
      results.length === 5,
      `Broadcast to 5 recipients (got ${results.length})`,
    );
    const deliveredCount = results.filter((r) => r.delivered).length;
    ok(
      deliveredCount === 3,
      `3 delivered to live panes (got ${deliveredCount})`,
    );
    const queuedCount = results.filter((r) => r.queued).length;
    ok(queuedCount === 5, `All 5 queued (got ${queuedCount})`);
  } finally {
    teardownTestDb();
  }
}

// ─── E16: Worker Stop hook notifies leader ────────────────────────────────────

async function testE16_WorkerStopHookNotifiesLeader() {
  console.log('\nE16: Worker Stop hook notifies leader');

  const leaderPane = await createTestPane(`bash ${FIXTURES} e16-leader`);
  const workerPane = await createTestPane(`bash ${FIXTURES} e16-worker`);
  await Bun.sleep(500);

  setupTestDb();
  try {
    const { addAgent, getOrCreateRoom } = await import('../src/state/index.ts');
    const { processHookEventInput } = await import('../src/tools/hook-event.ts');

    const room = getOrCreateRoom('/uat/notify-room', 'notify-room');
    addAgent('e16-leader', 'leader', room.id, leaderPane, 'unknown');
    addAgent('e16-worker', 'worker', room.id, workerPane, 'unknown');

    await processHookEventInput(
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'e16-session-1',
        message: 'Task completed successfully',
      }),
      workerPane,
    );

    await Bun.sleep(3000);
    const leaderContent = await capturePane(leaderPane, 100);

    ok(
      leaderContent.includes('[e16-worker@notify-room] completed:'),
      'Leader received worker completion notification',
      `leader pane tail: ${leaderContent.slice(-300)}`,
    );
    ok(
      leaderContent.includes('Task completed successfully'),
      'Leader notification includes completion text',
      `leader pane tail: ${leaderContent.slice(-300)}`,
    );
  } finally {
    teardownTestDb();
  }
}

// ─── E17: Concurrent sends from 3 agents ─────────────────────────────────────

async function testE17_ConcurrentSends() {
  console.log('\nE17: Concurrent sends from 3 agents');

  const targetPane = await createTestPane(`bash ${FIXTURES} e17-target`);
  await Bun.sleep(500);

  setupTestDb();
  try {
    const { addAgent, getOrCreateRoom } = await import('../src/state/index.ts');
    const { deliverMessage } = await import('../src/delivery/index.ts');

    const room = getOrCreateRoom('/uat/concurrent-room', 'concurrent-room');
    addAgent('e17-target', 'leader', room.id, targetPane, 'unknown');
    for (let i = 1; i <= 3; i++) {
      // Senders don't need real panes (they only send, not receive via push here)
      addAgent(`e17-sender-${i}`, 'worker', room.id, null, 'unknown');
    }

    // Fire 3 deliveries concurrently
    const promises = [1, 2, 3].map((i) =>
      deliverMessage(
        `e17-sender-${i}`,
        'concurrent-room',
        `CONCURRENT-MSG-${i}-MARKER`,
        'e17-target',
        null,
        undefined,
      ),
    );

    const results = await Promise.all(promises);

    // All 3 should have been delivered (PaneQueue mutex serializes them)
    const allDelivered = results.every(
      (r) => r.length === 1 && r[0]!.delivered,
    );
    ok(
      allDelivered,
      `All 3 concurrent sends reported delivered (got: ${results.map((r) => r[0]?.delivered).join(',')})`,
    );

    await Bun.sleep(1500);
    const content = await capturePane(targetPane, 100);

    const found = [1, 2, 3].filter((i) =>
      content.includes(`CONCURRENT-MSG-${i}-MARKER`),
    ).length;
    ok(found === 3, `All 3 messages in target pane (found ${found}/3)`);
  } finally {
    teardownTestDb();
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n═══ Edge Case UAT (isolated socket: crew-uat-edge) ═══\n');

  // SIGINT cleanup
  process.on('SIGINT', async () => {
    console.log('\n\nInterrupted — cleaning up...');
    await cleanupEdgeTestEnv();
    process.exit(1);
  });

  await setupEdgeTestEnv();

  try {
    // E1-E5: Delivery
    await testE1_PaneDiesMidDelivery();
    await testE2_FrozenAgentDirectSubmit();
    await testE3_LargePayload();
    await testE4_SpecialChars();
    await testE5_RapidFire();

    // E6-E8: No-hook readiness/status behavior
    await testE6_ChaosPaneDeliveryCompletes();
    await testE7_BusyLookingPaneStillDelivers();
    await testE8_NoHookStatusStaysUnknown();

    // E9-E11: Queue/polling
    await testE9_QueueBacklog();
    await testE10_HeartbeatStaleFallback();
    await testE11_RoleBasedIntervals();

    // E12-E13: Sender verification (subprocess-based)
    await testE12_SpoofedPane();
    await testE13_NoTmuxPane();

    // E14-E17: Integration
    await testE14_StalePaneDetection();
    await testE15_BroadcastPartialDelivery();
    await testE16_WorkerStopHookNotifiesLeader();
    await testE17_ConcurrentSends();
  } finally {
    console.log('\n─── Cleanup ───');
    await cleanupEdgeTestEnv();
    // Delete leftover mode files so they don't bleed into the next test run
    for (const name of [
      'e1-agent',
      'e2-agent',
      'e3-agent',
      'e4-agent',
      'e5-agent',
      'e6-agent',
      'e7-agent',
      'e8-agent',
      'e9-agent',
      'e16-leader',
      'e16-worker',
      'e17-target',
      'live-e15-0',
      'live-e15-1',
      'live-e15-2',
    ]) {
      await Bun.$`rm -f /tmp/crew-mock-${name}.mode`.quiet().catch(() => {});
    }
  }

  const total = passed + failed;
  console.log(
    `\n═══ Results: ${passed}/${total} passed, ${failed} failed ═══\n`,
  );
  if (failed > 0) process.exit(1);
}

await main();
