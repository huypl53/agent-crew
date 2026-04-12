#!/usr/bin/env bun
import { initDb, closeDb, addAgent, addMessage, createTask, updateTaskStatus } from '../src/state/index.ts';
import { handleCheckChanges } from '../src/tools/check-changes.ts';
import { handleReadMessages } from '../src/tools/read-messages.ts';
import { handleGetStatus } from '../src/tools/get-status.ts';

let passed = 0, failed = 0;

function assert(condition: boolean, label: string, extra?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
    failed++;
  }
}

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

function scopes(result: any): Record<string, { version: number; updated_at: string }> {
  return JSON.parse(result.content[0].text).scopes;
}

// ─── Group 1: Version Correctness ───────────────────────────────────────────

console.log('\n=== Version Correctness ===\n');

initDb(':memory:');
addAgent('lead-01', 'leader', 'alpha', '%0');

// TC-V1 — All three scopes present on fresh DB
{
  const r = await handleCheckChanges({ name: 'lead-01', scopes: ['messages', 'tasks', 'agents'] });
  const s = scopes(r);
  assert(!r.isError, 'TC-V1: result is ok (no error)');
  assert('messages' in s && 'tasks' in s && 'agents' in s, 'TC-V1: all three scopes present');
  assert(typeof s.messages!.version === 'number', 'TC-V1: messages has numeric version');
  assert(typeof s.messages!.updated_at === 'string', 'TC-V1: messages has updated_at string');
}

// TC-V2 — messages version bumps on new message
{
  const s1 = scopes(await handleCheckChanges({ name: 'lead-01', scopes: ['messages', 'tasks', 'agents'] }));
  const [mv1, tv1, av1] = [s1.messages!.version, s1.tasks!.version, s1.agents!.version];

  addMessage('', 'lead-01', 'alpha', 'hello world', 'pull', null);

  const s2 = scopes(await handleCheckChanges({ name: 'lead-01', scopes: ['messages', 'tasks', 'agents'] }));
  assert(s2.messages!.version > mv1, 'TC-V2: messages version bumped', `${mv1} → ${s2.messages!.version}`);
  assert(s2.tasks!.version === tv1, 'TC-V2: tasks version unchanged');
  assert(s2.agents!.version === av1, 'TC-V2: agents version unchanged');
}

// TC-V3 — tasks version bumps on task create
{
  const s1 = scopes(await handleCheckChanges({ name: 'lead-01', scopes: ['messages', 'tasks', 'agents'] }));
  const [mv1, tv1, av1] = [s1.messages!.version, s1.tasks!.version, s1.agents!.version];

  createTask('alpha', 'lead-01', 'lead-01', null, 'do something');

  const s2 = scopes(await handleCheckChanges({ name: 'lead-01', scopes: ['messages', 'tasks', 'agents'] }));
  assert(s2.tasks!.version > tv1, 'TC-V3: tasks version bumped on create', `${tv1} → ${s2.tasks!.version}`);
  assert(s2.messages!.version === mv1, 'TC-V3: messages version unchanged');
  assert(s2.agents!.version === av1, 'TC-V3: agents version unchanged');
}

// TC-V4 — tasks version bumps on task status update
{
  const task = createTask('alpha', 'lead-01', 'lead-01', null, 'task to update');
  const s1 = scopes(await handleCheckChanges({ name: 'lead-01', scopes: ['tasks'] }));
  const tv1 = s1.tasks!.version;

  updateTaskStatus(task.id, 'active');

  const s2 = scopes(await handleCheckChanges({ name: 'lead-01', scopes: ['tasks'] }));
  assert(s2.tasks!.version > tv1, 'TC-V4: tasks version bumped on status update', `${tv1} → ${s2.tasks!.version}`);
}

// TC-V5 — agents version bumps on agent join
{
  const s1 = scopes(await handleCheckChanges({ name: 'lead-01', scopes: ['agents'] }));
  const av1 = s1.agents!.version;

  addAgent('new-wk', 'worker', 'alpha', '%9');

  const s2 = scopes(await handleCheckChanges({ name: 'lead-01', scopes: ['agents'] }));
  assert(s2.agents!.version > av1, 'TC-V5: agents version bumped on join', `${av1} → ${s2.agents!.version}`);
}

// TC-V6 — scope filtering: only requested scopes returned
{
  const s = scopes(await handleCheckChanges({ name: 'lead-01', scopes: ['tasks'] }));
  assert('tasks' in s, 'TC-V6: tasks scope present');
  assert(!('messages' in s), 'TC-V6: messages scope absent');
  assert(!('agents' in s), 'TC-V6: agents scope absent');
}

// TC-V7 — invalid scopes silently ignored
{
  const r = await handleCheckChanges({ name: 'lead-01', scopes: ['tasks', 'nonexistent'] });
  const s = scopes(r);
  assert(!r.isError, 'TC-V7: no error with invalid scope');
  assert('tasks' in s, 'TC-V7: valid scope returned');
  assert(!('nonexistent' in s), 'TC-V7: invalid scope ignored');
}

// TC-V8 — default scopes (omit scopes param)
{
  const s = scopes(await handleCheckChanges({ name: 'lead-01' }));
  assert('messages' in s && 'tasks' in s && 'agents' in s, 'TC-V8: all scopes returned by default');
}

closeDb();

// ─── Group 2: Cost Reduction ─────────────────────────────────────────────────

console.log('\n=== Cost Reduction ===\n');

// TC-C1 — check_changes output is smaller than read_messages (≥10x)
{
  initDb(':memory:');
  addAgent('lead-01', 'leader', 'alpha', '%0');

  for (let i = 0; i < 20; i++) {
    addMessage('', 'lead-01', 'alpha', `msg ${i}: ${'x'.repeat(60)}`, 'pull', null);
  }

  const checkResult = await handleCheckChanges({ name: 'lead-01' });
  const readResult  = await handleReadMessages({ name: 'lead-01', room: 'alpha', limit: 50 });

  const checkSz = size(checkResult);
  const readSz  = size(readResult);
  const ratio   = (readSz / checkSz).toFixed(1);
  console.log(`  TC-C1: check_changes=${checkSz}B  read_messages=${readSz}B  ratio=${ratio}x`);
  assert(checkSz * 10 <= readSz, 'TC-C1: check_changes ≥10x smaller than read_messages', `ratio=${ratio}x`);

  closeDb();
}

// TC-C2 — check_changes output is smaller than get_status (≥5x)
{
  initDb(':memory:');
  addAgent('lead-01', 'leader', 'alpha', '%0');
  for (let i = 1; i <= 4; i++) addAgent(`wk-0${i}`, 'worker', 'alpha', `%${i}`);

  // 1 active task + 9 queued on lead-01
  const first = createTask('alpha', 'lead-01', 'lead-01', null, `Task 1: ${'x'.repeat(80)}`);
  updateTaskStatus(first.id, 'active');
  for (let i = 2; i <= 10; i++) {
    createTask('alpha', 'lead-01', 'lead-01', null, `Task ${i}: ${'x'.repeat(80)}`);
  }

  const checkResult  = await handleCheckChanges({ name: 'lead-01' });
  const statusResult = await handleGetStatus({ agent_name: 'lead-01' });

  const checkSz  = size(checkResult);
  const statusSz = size(statusResult);
  const ratio    = (statusSz / checkSz).toFixed(1);
  console.log(`  TC-C2: check_changes=${checkSz}B  get_status=${statusSz}B  ratio=${ratio}x`);
  assert(checkSz * 5 <= statusSz, 'TC-C2: check_changes ≥5x smaller than get_status', `ratio=${ratio}x`);

  closeDb();
}

// TC-C3 — stable versions when no state changes
{
  initDb(':memory:');
  addAgent('lead-01', 'leader', 'alpha', '%0');

  const s1 = scopes(await handleCheckChanges({ name: 'lead-01' }));
  // No mutations
  const s2 = scopes(await handleCheckChanges({ name: 'lead-01' }));

  assert(s1.messages!.version === s2.messages!.version, 'TC-C3: messages version stable');
  assert(s1.tasks!.version    === s2.tasks!.version,    'TC-C3: tasks version stable');
  assert(s1.agents!.version   === s2.agents!.version,   'TC-C3: agents version stable');

  closeDb();
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
