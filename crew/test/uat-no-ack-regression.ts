#!/usr/bin/env bun
import { getPollingInterval } from '../src/delivery/pane-queue.ts';
/**
 * UAT: No-ACK regression test — verifies the system works correctly when
 * agents never call `crew ack`. Proves polling-based delivery is sufficient
 * and that ACK infrastructure (when present) causes no regression.
 *
 * Usage: bun crew/test/uat-no-ack-regression.ts
 */
import {
  addAgent,
  addMessage,
  closeDb,
  getAllMessages,
  initDb,
  readMessages,
} from '../src/state/index.ts';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ─── Setup ───────────────────────────────────────────────────────────────────

console.log('\n═══ No-ACK Regression UAT ═══\n');

initDb(':memory:');

// Register agents
addAgent('boss-1', 'boss', 'main', null);
addAgent('leader-1', 'leader', 'main', null);
addAgent('worker-1', 'worker', 'main', null);

// ─── Group 1: Message delivery without ACK ────────────────────────────────

console.log('--- Group 1: Message delivery without ACK ---\n');

// TC-1: Message is stored in DB when sent (no ACK required)
{
  const msg = addMessage(
    'worker-1',
    'leader-1',
    'main',
    'task: build login page',
    'pull',
    'worker-1',
    'task',
  );
  assert(!!msg.message_id, 'TC-1: message written to DB immediately on send');
  assert(msg.from === 'leader-1', 'TC-1: sender recorded correctly');
  assert(msg.room === 'main', 'TC-1: room recorded correctly');
}

// TC-2: Recipient can read messages without ever sending an ACK
{
  addMessage(
    'worker-1',
    'leader-1',
    'main',
    'ping: are you alive?',
    'pull',
    'worker-1',
    'chat',
  );
  const { messages } = readMessages('worker-1');
  assert(
    messages.length >= 1,
    'TC-2: worker can read messages without sending ACK',
    `found ${messages.length} messages`,
  );
  assert(
    messages.some((m) => m.text === 'ping: are you alive?'),
    'TC-2: correct message content accessible',
  );
}

// TC-3: Multiple messages accumulate in DB without ACK
{
  for (let i = 1; i <= 5; i++) {
    addMessage(
      'worker-1',
      'leader-1',
      'main',
      `batch-msg-${i}`,
      'pull',
      'worker-1',
      'chat',
    );
  }
  const all = getAllMessages();
  const workerMessages = all.filter((m) => m.to === 'worker-1');
  assert(
    workerMessages.length >= 5,
    'TC-3: all 5 messages stored without ACK',
    `found ${workerMessages.length}`,
  );
}

// TC-4: Cursor-based read works as polling fallback (simulates agent polling)
{
  // Fresh agent with no cursor — first read gets all messages
  addAgent('worker-2', 'worker', 'alpha', null);
  addMessage(
    'worker-2',
    'leader-1',
    'alpha',
    'first task',
    'pull',
    'worker-2',
    'task',
  );
  addMessage(
    'worker-2',
    'leader-1',
    'alpha',
    'second task',
    'pull',
    'worker-2',
    'task',
  );

  const poll1 = readMessages('worker-2', 'alpha');
  assert(
    poll1.messages.length === 2,
    'TC-4: first poll gets all pending messages',
    `got ${poll1.messages.length}`,
  );

  // Second poll with same cursor — no new messages (idempotent)
  const { messages: newMsgs } = readMessages(
    'worker-2',
    'alpha',
    poll1.next_sequence,
  );
  assert(
    newMsgs.length === 0,
    'TC-4: second poll (same cursor) returns no new messages',
  );

  // New message arrives, third poll picks it up
  addMessage(
    'worker-2',
    'leader-1',
    'alpha',
    'third task',
    'pull',
    'worker-2',
    'task',
  );
  const { messages: poll3 } = readMessages(
    'worker-2',
    'alpha',
    poll1.next_sequence,
  );
  assert(poll3.length === 1, 'TC-4: third poll finds newly added message');
  assert(
    poll3[0]!.text === 'third task',
    'TC-4: correct message content in third poll',
  );
}

// ─── Group 2: Agent status detection via polling (no ACK) ─────────────────

console.log('\n--- Group 2: Agent status detection without ACK ---\n');

// TC-5: getPollingInterval returns 500ms in conservative mode
{
  const original = process.env.CREW_POLLING_PROFILE;
  process.env.CREW_POLLING_PROFILE = 'conservative';
  // Re-import config won't pick up env change in same process, so we test the
  // logic directly by calling with a simulated conservative environment.
  // Note: config is module-level singleton, so we test getPollingInterval logic directly.
  // The actual conservative branch is tested by passing a stale lastActivityMs.
  const staleMs = Date.now() - 35_000; // 35s ago — beyond 30s threshold
  const interval = getPollingInterval('worker', staleMs);
  assert(
    interval === 500,
    'TC-5: stale heartbeat (35s) triggers conservative 500ms fallback',
    `got ${interval}ms`,
  );
  if (original !== undefined) process.env.CREW_POLLING_PROFILE = original;
  else delete process.env.CREW_POLLING_PROFILE;
}

// TC-6: getPollingInterval returns role-based intervals for fresh agents (reduced profile)
{
  const freshMs = Date.now() - 1_000; // 1s ago — fresh
  const workerInterval = getPollingInterval('worker', freshMs);
  const leaderInterval = getPollingInterval('leader', freshMs);
  const bossInterval = getPollingInterval('boss', freshMs);

  // In reduced profile (default), role-based intervals apply
  assert(
    workerInterval === 2_000,
    `TC-6: worker interval = 2000ms (got ${workerInterval}ms)`,
  );
  assert(
    leaderInterval === 5_000,
    `TC-6: leader interval = 5000ms (got ${leaderInterval}ms)`,
  );
  assert(
    bossInterval === 10_000,
    `TC-6: boss interval = 10000ms (got ${bossInterval}ms)`,
  );
}

// TC-7: getPollingInterval with no lastActivityMs uses profile only (no stale check)
{
  const interval = getPollingInterval('worker'); // no lastActivityMs
  assert(
    interval === 2_000,
    `TC-7: no heartbeat data → uses profile interval (got ${interval}ms)`,
  );
}

// TC-8: getPollingInterval stale threshold is exactly 30s boundary
{
  const exactlyStale = Date.now() - 30_001; // 1ms past threshold
  const justFresh = Date.now() - 29_999; // 1ms before threshold

  const staleInterval = getPollingInterval('worker', exactlyStale);
  const freshInterval = getPollingInterval('worker', justFresh);

  assert(
    staleInterval === 500,
    `TC-8: 30001ms old → conservative 500ms (got ${staleInterval}ms)`,
  );
  assert(
    freshInterval === 2_000,
    `TC-8: 29999ms old → reduced 2000ms  (got ${freshInterval}ms)`,
  );
}

// ─── Group 3: ACK-present-but-unused causes no regression ─────────────────

console.log('\n--- Group 3: ACK infrastructure present but unused ---\n');

// TC-9: System works correctly when delivery mode is 'pull' (no push/ACK)
{
  addAgent('worker-3', 'worker', 'beta', null);
  const msg = addMessage(
    'worker-3',
    'boss-1',
    'beta',
    'no-ack task',
    'pull',
    'worker-3',
    'task',
  );
  assert(msg.mode === 'pull', 'TC-9: message stored with pull mode');

  const { messages } = readMessages('worker-3');
  const found = messages.find((m) => m.message_id === msg.message_id);
  assert(!!found, 'TC-9: message readable by polling without any ACK');
}

// TC-10: Multiple agents each poll independently — no cross-contamination
{
  addAgent('worker-4', 'worker', 'gamma', null);
  addAgent('worker-5', 'worker', 'gamma', null);

  addMessage(
    'worker-4',
    'leader-1',
    'gamma',
    'for worker-4',
    'pull',
    'worker-4',
    'chat',
  );
  addMessage(
    'worker-5',
    'leader-1',
    'gamma',
    'for worker-5',
    'pull',
    'worker-5',
    'chat',
  );

  const w4 = readMessages('worker-4');
  const w5 = readMessages('worker-5');

  assert(
    w4.messages.every((m) => m.to === 'worker-4'),
    'TC-10: worker-4 only sees its own messages',
  );
  assert(
    w5.messages.every((m) => m.to === 'worker-5'),
    'TC-10: worker-5 only sees its own messages',
  );
  assert(
    w4.messages.some((m) => m.text === 'for worker-4'),
    'TC-10: worker-4 receives correct content',
  );
  assert(
    w5.messages.some((m) => m.text === 'for worker-5'),
    'TC-10: worker-5 receives correct content',
  );
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

closeDb();

console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
if (failed > 0) process.exit(1);
