#!/usr/bin/env bun
/**
 * UAT: Dashboard Controls — agent and task action functions
 * Tests revokeAgent, interruptAgent, clearAgentSession, interruptTask, cancelTask, reassignTask
 *
 * Usage: bun test/uat-dashboard-controls.ts
 */
import { tmpdir } from 'os';
import { join } from 'path';
import { mock } from 'bun:test';

// Speed up setTimeout so clearAgentSession's 2-second delay is instant
const _realSetTimeout = globalThis.setTimeout;
(globalThis as any).setTimeout = (fn: Function, _ms: number, ...args: any[]) =>
  _realSetTimeout(fn as TimerHandler, 0, ...args);

// Isolated state dir
const stateDir = join(tmpdir(), `crew-uat-dashboard-${Date.now()}`);
process.env.CREW_STATE_DIR = stateDir;

// Stateful tmux mock — tests update these to control behavior
const tmuxState = {
  paneAlive: true,
  keyCalls: [] as string[],
  escapeCalls: [] as string[],
};

function resetMock(paneAlive: boolean) {
  tmuxState.paneAlive = paneAlive;
  tmuxState.keyCalls = [];
  tmuxState.escapeCalls = [];
}

// Mock the tmux module BEFORE importing action modules that depend on it
mock.module('../src/tmux/index.ts', () => ({
  paneExists: async (_t: string) => tmuxState.paneAlive,
  sendEscape: async (t: string) => { tmuxState.escapeCalls.push(t); return { delivered: true }; },
  sendKeys: async (_t: string, k: string) => { tmuxState.keyCalls.push(k); return { delivered: true }; },
  sendClear: async () => ({ delivered: true }),
  validateTmux: async () => ({ ok: true }),
  isPaneDead: async () => !tmuxState.paneAlive,
  capturePane: async () => null,
}));

// Now import action modules (they will bind to the mocked tmux)
const { revokeAgent, interruptAgent, clearAgentSession } =
  await import('../src/dashboard/actions/agent-actions.ts');
const { interruptTask, cancelTask, reassignTask } =
  await import('../src/dashboard/actions/task-actions.ts');

// State functions (direct imports — not action modules, so order doesn't matter)
const { initDb } = await import('../src/state/db.ts');
const { addAgent, createTask, getTask, updateTaskStatus, getAgent } =
  await import('../src/state/index.ts');

import type { Task } from '../src/shared/types.ts';

// Warm up: trigger ensureDb() in action modules (sets initialized=true)
// so our per-test initDb(':memory:') calls won't be overwritten.
try { await revokeAgent('__warmup__'); } catch {}

// =============================================================================
// Test helpers
// =============================================================================
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function assertThrows(fn: () => Promise<any>, label: string, containing?: string) {
  try {
    await fn();
    console.error(`  ✗ ${label} — expected error, got none`);
    failed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (containing && !msg.toLowerCase().includes(containing.toLowerCase())) {
      console.error(`  ✗ ${label} — error "${msg}" doesn't contain "${containing}"`);
      failed++;
    } else {
      console.log(`  ✓ ${label}`);
      passed++;
    }
  }
}

function freshDb() {
  initDb(':memory:');
}

function makeAgent(name: string, pane: string, role = 'worker', room = 'alpha') {
  addAgent(name, role as any, room, pane);
}

function makeTask(agentName: string, targetStatus: string, room = 'alpha'): Task {
  const t = createTask(room, agentName, 'test', null, `task for ${agentName}`);
  if (targetStatus !== 'sent') {
    updateTaskStatus(t.id, targetStatus as any);
  }
  return getTask(t.id)!;
}

// =============================================================================
// AGENT ACTIONS
// =============================================================================
console.log('\n=== Agent Actions ===\n');

// TC-A1: revokeAgent — happy path
{
  console.log('TC-A1 — revokeAgent: happy path');
  freshDb();
  resetMock(true);
  makeAgent('wk-01', '%1');
  const task = makeTask('wk-01', 'active');

  const result = await revokeAgent('wk-01');
  assert(result.includes('Revoked') && result.includes('wk-01'), 'returns "Revoked wk-01"', result);
  // cleanupDeadAgentTasks overwrites 'interrupted' → 'error' for all remaining tasks
  assert(getTask(task.id)?.status === 'error', `task ended as error (got: ${getTask(task.id)?.status})`);
  assert(getAgent('wk-01') === undefined, 'agent removed from DB');
  console.log();
}

// TC-A2: revokeAgent — agent not found
{
  console.log('TC-A2 — revokeAgent: agent not found');
  freshDb();
  resetMock(true);

  await assertThrows(() => revokeAgent('ghost'), 'throws with agent name', 'ghost');
  console.log();
}

// TC-A3: interruptAgent — happy path
{
  console.log('TC-A3 — interruptAgent: happy path');
  freshDb();
  resetMock(true);
  makeAgent('wk-02', '%2');
  const task = makeTask('wk-02', 'active');

  const result = await interruptAgent('wk-02');
  assert(result.includes('Interrupted') && result.includes('wk-02'), 'returns "Interrupted wk-02"', result);
  assert(result.includes(String(task.id)), `result contains task id #${task.id}`, result);
  assert(getTask(task.id)?.status === 'interrupted', `task is interrupted (got: ${getTask(task.id)?.status})`);
  assert(getAgent('wk-02') !== undefined, 'agent still exists');
  console.log();
}

// TC-A4: interruptAgent — no active task
{
  console.log('TC-A4 — interruptAgent: no active task');
  freshDb();
  resetMock(true);
  makeAgent('wk-03', '%3');

  await assertThrows(() => interruptAgent('wk-03'), 'throws "no active task"', 'no active task');
  console.log();
}

// TC-A5: interruptAgent — pane is dead
{
  console.log('TC-A5 — interruptAgent: pane is dead');
  freshDb();
  resetMock(false);
  makeAgent('wk-04', '%4');
  makeTask('wk-04', 'active');

  await assertThrows(() => interruptAgent('wk-04'), 'throws "pane is dead"', 'pane is dead');
  console.log();
}

// TC-A6: clearAgentSession — happy path
{
  console.log('TC-A6 — clearAgentSession: happy path');
  freshDb();
  resetMock(true);
  makeAgent('wk-05', '%5');

  const result = await clearAgentSession('wk-05');
  assert(result.includes('Cleared') && result.includes('wk-05'), 'returns "Cleared wk-05 session"', result);
  assert(tmuxState.keyCalls.length === 2, `sendKeys called twice (got ${tmuxState.keyCalls.length})`);
  assert(tmuxState.keyCalls[0] === '/clear', `first sendKeys is "/clear" (got "${tmuxState.keyCalls[0]}")`);
  assert(
    tmuxState.keyCalls[1] === '/crew:refresh --name wk-05',
    `second sendKeys is "/crew:refresh --name wk-05" (got "${tmuxState.keyCalls[1]}")`,
  );
  console.log();
}

// TC-A7: clearAgentSession — pane is dead
{
  console.log('TC-A7 — clearAgentSession: pane is dead');
  freshDb();
  resetMock(false);
  makeAgent('wk-06', '%6');

  await assertThrows(() => clearAgentSession('wk-06'), 'throws "pane is dead"', 'pane is dead');
  console.log();
}

// =============================================================================
// TASK ACTIONS
// =============================================================================
console.log('=== Task Actions ===\n');

// TC-T1: interruptTask — happy path
{
  console.log('TC-T1 — interruptTask: happy path');
  freshDb();
  resetMock(true);
  makeAgent('wk-01', '%1');
  const task = makeTask('wk-01', 'active');

  const result = await interruptTask(task);
  assert(result.includes(`Interrupted task #${task.id}`), 'returns "Interrupted task #<id>"', result);
  assert(getTask(task.id)?.status === 'interrupted', 'task status is interrupted');
  console.log();
}

// TC-T2: interruptTask — wrong status
{
  console.log('TC-T2 — interruptTask: wrong status (queued)');
  freshDb();
  resetMock(true);
  makeAgent('wk-01', '%1');
  const task = makeTask('wk-01', 'queued');

  await assertThrows(() => interruptTask(task), 'throws must be "active"', 'must be "active"');
  console.log();
}

// TC-T3: cancelTask — happy path
{
  console.log('TC-T3 — cancelTask: happy path');
  freshDb();
  makeAgent('wk-01', '%1');
  const task = makeTask('wk-01', 'queued');

  const result = await cancelTask(task);
  assert(result.includes(`Cancelled task #${task.id}`), 'returns "Cancelled task #<id>"', result);
  assert(getTask(task.id)?.status === 'cancelled', 'task status is cancelled');
  console.log();
}

// TC-T4: cancelTask — wrong status (active)
{
  console.log('TC-T4 — cancelTask: wrong status (active)');
  freshDb();
  makeAgent('wk-01', '%1');
  const task = makeTask('wk-01', 'active');

  await assertThrows(() => cancelTask(task), 'throws must be "queued"', 'must be "queued"');
  console.log();
}

// TC-T5: reassignTask — from active
{
  console.log('TC-T5 — reassignTask: from active');
  freshDb();
  resetMock(true);
  makeAgent('wk-01', '%1');
  const task = makeTask('wk-01', 'active');

  const result = await reassignTask(task, 'new task text');
  assert(getTask(task.id)?.status === 'interrupted', 'old task is interrupted');
  assert(result.includes(`old #${task.id}`), 'result contains old id', result);
  const newId = parseInt(result.match(/new #(\d+)/)?.[1] ?? '0');
  assert(newId > task.id, `new task created (id #${newId})`);
  assert(getTask(newId)?.summary === 'new task text', 'new task has correct text');
  assert(tmuxState.keyCalls.some(k => k === 'new task text'), 'sendKeys called with new text');
  console.log();
}

// TC-T6: reassignTask — from queued
{
  console.log('TC-T6 — reassignTask: from queued');
  freshDb();
  resetMock(true);
  makeAgent('wk-01', '%1');
  const task = makeTask('wk-01', 'queued');

  const result = await reassignTask(task, 'revised text');
  assert(getTask(task.id)?.status === 'cancelled', 'old task is cancelled');
  const newId = parseInt(result.match(/new #(\d+)/)?.[1] ?? '0');
  assert(newId > task.id, `new task created (id #${newId})`);
  assert(getTask(newId)?.summary === 'revised text', 'new task has correct text');
  console.log();
}

// =============================================================================
// Summary
// =============================================================================
console.log(`${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll tests passed.');
}
