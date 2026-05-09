#!/usr/bin/env bun
/**
 * UAT: Party Mode E2E test with real Claude Code workers.
 *
 * Creates a tmux session with 1 leader pane + 2 worker panes running Claude Code
 * in bypass permission mode. Tests the full party flow:
 *   1. Agents join room
 *   2. Leader starts party with topic
 *   3. Workers receive topic, respond
 *   4. Leader receives digest
 *   5. Leader sends next round (workers see prev responses)
 *   6. Leader ends party
 *
 * Usage:
 *   bun test/uat-party-mode.ts [--keep]
 *
 * Options:
 *   --keep  Don't kill tmux session after test (for debugging)
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHooks } from '../src/hooks/install-hooks.ts';
import { closeDb, initDb } from '../src/state/index.ts';

const SESSION = 'crew-party-uat';
const ROOM = 'party-test';
const TEST_DIR = join(tmpdir(), 'crew-party-uat');
const STATE_DIR = join(TEST_DIR, 'state');
const KEEP_SESSION = process.argv.includes('--keep');

let passed = 0;
let failed = 0;
let serverProc: ReturnType<typeof Bun.spawn> | null = null;

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function sh(cmd: string): Promise<string> {
  const proc = Bun.spawn(['bash', '-c', cmd], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function crewCmd(args: string): Promise<string> {
  return sh(`CREW_STATE_DIR="${STATE_DIR}" bun src/cli.ts ${args}`);
}

async function capturePane(paneId: string): Promise<string> {
  return sh(`tmux capture-pane -p -J -t ${paneId} -S -100`);
}

async function sendToPane(paneId: string, text: string): Promise<void> {
  // Use paste-buffer for reliability
  const escaped = text.replace(/'/g, "'\\''");
  await sh(`echo '${escaped}' | tmux load-buffer -`);
  await sh(`tmux paste-buffer -dp -t ${paneId}`);
}

async function waitForText(
  paneId: string,
  marker: string,
  timeoutMs = 60000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await capturePane(paneId);
    if (text.includes(marker)) return true;
    await Bun.sleep(1000);
  }
  return false;
}

async function waitForIdle(paneId: string, timeoutMs = 120000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  await Bun.sleep(2000);
  while (Date.now() < deadline) {
    const text = await capturePane(paneId);
    const lines = text.split('\n').filter((l) => l.trim());
    const bottom = lines.slice(-15).join('\n');
    // Claude Code idle indicators
    const hasPrompt = bottom.includes('❯') || bottom.includes('bypass permissions');
    const isBusy = /[·✶✽✻]\s+\w+…/.test(bottom);
    if (hasPrompt && !isBusy) return true;
    await Bun.sleep(2000);
  }
  return false;
}

// ─── SETUP ───

async function setup(): Promise<{ leader: string; workers: string[] }> {
  log('Setting up test environment...');

  // Clean previous run
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });

  // Init DB
  initDb(join(STATE_DIR, 'crew.db'));

  // Kill existing session
  await sh(`tmux kill-session -t ${SESSION} 2>/dev/null || true`);

  // Create session with 3 panes (1 leader + 2 workers)
  await sh(`tmux new-session -d -s ${SESSION} -x 120 -y 30`);
  await sh(`tmux split-window -h -t ${SESSION}`);
  await sh(`tmux split-window -v -t ${SESSION}`);

  // Get pane IDs
  const panes = (await sh(`tmux list-panes -t ${SESSION} -F '#{pane_id}'`)).split('\n');
  const [leaderPane, worker1, worker2] = panes;

  log(`Panes: leader=${leaderPane}, workers=[${worker1}, ${worker2}]`);

  // Set CREW_STATE_DIR in all panes
  for (const pane of panes) {
    await sh(`tmux send-keys -t ${pane} 'export CREW_STATE_DIR="${STATE_DIR}"' Enter`);
    await Bun.sleep(200);
  }

  // Start server in leader pane (background)
  log('Starting crew server...');
  serverProc = Bun.spawn(
    ['bun', 'src/server/index.ts'],
    {
      cwd: process.cwd(),
      env: { ...process.env, CREW_STATE_DIR: STATE_DIR },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  await Bun.sleep(2000); // Let server start

  // Create room
  await crewCmd(`room create --cwd /tmp --name ${ROOM}`);

  // Register agents
  await crewCmd(`join --name leader-1 --role leader --room ${ROOM} --pane ${leaderPane}`);
  await crewCmd(`join --name worker-a --role worker --room ${ROOM} --pane ${worker1}`);
  await crewCmd(`join --name worker-b --role worker --room ${ROOM} --pane ${worker2}`);

  log('Agents registered');

  return { leader: leaderPane, workers: [worker1, worker2] };
}

async function launchClaudeCode(paneId: string, agentName: string): Promise<void> {
  log(`Launching Claude Code for ${agentName} in ${paneId}...`);

  // Launch Claude Code with bypass permissions
  await sh(
    `tmux send-keys -t ${paneId} 'cd /tmp && claude --dangerously-skip-permissions' Enter`,
  );

  // Wait for Claude Code to fully start (look for bypass permissions indicator)
  const started = await waitForText(paneId, 'bypass permissions', 45000);
  if (!started) {
    log(`WARNING: Claude Code may not have started in ${paneId}`);
    return;
  }

  log(`Claude Code started for ${agentName}`);
}

// ─── TESTS ───

async function testPartyStart(
  leaderPane: string,
  workerPanes: string[],
): Promise<boolean> {
  log('TEST: Party Start');

  // Start party via CLI
  const result = await crewCmd(
    `party start --name leader-1 --topic "What is the best programming language and why?"`,
  );

  log(`Party start result: ${result}`);
  assert(result.includes('"started":true'), 'Party started successfully');
  assert(result.includes('"round":1'), 'Round is 1');

  // Wait for workers to receive topic (delivery is async)
  log('Waiting for topic delivery...');
  await Bun.sleep(5000);

  for (let i = 0; i < workerPanes.length; i++) {
    const text = await capturePane(workerPanes[i]);
    log(`Worker ${i + 1} pane content (last 500 chars): ${text.slice(-500)}`);
    const hasTopic = text.includes('party@') || text.includes('best programming language') || text.includes('Topic:');
    assert(hasTopic, `Worker ${i + 1} received topic`);
  }

  return failed === 0;
}

async function testWorkerResponses(workerPanes: string[]): Promise<boolean> {
  log('TEST: Worker Responses');

  // Send responses from workers
  for (let i = 0; i < workerPanes.length; i++) {
    const response = `Worker ${i + 1} thinks Rust is great because of memory safety.`;
    await sendToPane(workerPanes[i], response);
    await Bun.sleep(500);
  }

  // Wait for workers to process
  for (const pane of workerPanes) {
    await waitForIdle(pane, 60000);
  }

  // Check party status
  const status = await crewCmd(`party status --room ${ROOM}`);
  log(`Party status: ${status}`);

  // Should show responses captured (depends on hook timing)
  await Bun.sleep(3000);

  return true;
}

async function testPartyDigest(leaderPane: string): Promise<boolean> {
  log('TEST: Party Digest');

  // Wait for digest to arrive at leader
  await Bun.sleep(5000);

  const leaderText = await capturePane(leaderPane);

  // Check if round complete notification arrived
  const hasDigest =
    leaderText.includes('Round') && leaderText.includes('complete');

  assert(hasDigest, 'Leader received round digest');

  return hasDigest;
}

async function testPartyNext(
  leaderPane: string,
  workerPanes: string[],
): Promise<boolean> {
  log('TEST: Party Next Round');

  // Leader starts next round
  const result = await crewCmd(
    `party next --name leader-1 --topic "Now debate TypeScript vs JavaScript"`,
  );

  assert(result.includes('"round":2'), 'Advanced to round 2');

  // Wait for workers to receive prev responses + new topic
  await Bun.sleep(3000);

  for (let i = 0; i < workerPanes.length; i++) {
    const text = await capturePane(workerPanes[i]);
    const hasPrevResponses = text.includes('Previous round') || text.includes('round:2');
    assert(hasPrevResponses, `Worker ${i + 1} received round 2 with context`);
  }

  return failed === 0;
}

async function testPartyEnd(): Promise<boolean> {
  log('TEST: Party End');

  const result = await crewCmd(`party end --name leader-1`);

  assert(result.includes('"ended":true'), 'Party ended successfully');

  // Verify state
  const status = await crewCmd(`party status --room ${ROOM}`);
  assert(status.includes('"active":false'), 'Party marked inactive');

  return failed === 0;
}

async function testPartySkip(): Promise<boolean> {
  log('TEST: Party Skip Worker');

  // Start new party
  await crewCmd(`party start --name leader-1 --topic "Quick round"`);

  // Skip worker-a
  const result = await crewCmd(`party skip --name leader-1 --worker worker-a`);

  assert(result.includes('"skipped":"worker-a"'), 'Worker skipped');

  // End party
  await crewCmd(`party end --name leader-1`);

  return failed === 0;
}

// ─── CLEANUP ───

async function cleanup(): Promise<void> {
  log('Cleaning up...');

  if (serverProc) {
    serverProc.kill();
  }

  closeDb();

  if (!KEEP_SESSION) {
    await sh(`tmux kill-session -t ${SESSION} 2>/dev/null || true`);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  } else {
    log(`Session kept: tmux attach -t ${SESSION}`);
    log(`State dir: ${STATE_DIR}`);
  }
}

// ─── MAIN ───

async function main(): Promise<void> {
  console.log('\n═══ Party Mode E2E UAT ═══\n');

  try {
    const { leader, workers } = await setup();

    // Install hooks before launching Claude Code
    await installHooks('/tmp');
    log('Hooks installed to /tmp/.claude/settings.local.json');

    // Launch Claude Code in worker panes only (leader uses CLI)
    for (let i = 0; i < workers.length; i++) {
      await launchClaudeCode(workers[i], `worker-${String.fromCharCode(97 + i)}`);
    }

    // Wait for all workers to be fully ready
    log('Waiting for all workers to be ready...');
    await Bun.sleep(3000);

    // Run tests
    await testPartyStart(leader, workers);
    await testWorkerResponses(workers);
    await testPartyDigest(leader);
    await testPartyNext(leader, workers);
    await testPartyEnd();
    await testPartySkip();
  } catch (err) {
    console.error('UAT Error:', err);
    failed++;
  } finally {
    await cleanup();
  }

  console.log('\n═══ Results ═══\n');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
