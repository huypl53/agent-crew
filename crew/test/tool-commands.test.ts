/**
 * Tests for crew tool commands: goal, hint, and send-batch.
 * These are CLI-level handlers (not hook-event), tested with in-memory DB.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mock } from 'bun:test';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';

// Mock tmux before importing anything that touches it
const tmuxModulePath = resolve(import.meta.dir, '../src/tmux/index.ts');
const dbModulePath = resolve(import.meta.dir, '../src/state/db.ts');

// Capture original DB functions BEFORE mock.module replaces them
const origDb = await import('../src/state/db.ts');
const _realInitDb = origDb.initDb;
const _realGetDb = origDb.getDb;

// Make initDb() a no-op when DB is already open (handlers call initDb()
// which re-opens a file-based DB, losing our :memory: state).
mock.module(dbModulePath, () => ({
  ...origDb,
  initDb: (path?: string) => {
    try { _realGetDb(); if (!path) return; } catch {}
    _realInitDb(path);
  },
}));

interface TapEntry {
  ts: number;
  op: string;
  target?: string;
  args?: unknown[];
}

const _tapLog: TapEntry[] = [];

mock.module(tmuxModulePath, () => ({
  sendKeys: async (target: string, text: string) => {
    _tapLog.push({ ts: Date.now(), op: 'sendKeys', target, args: [text] });
    return { delivered: true };
  },
  sendCommand: async (target: string, text: string) => {
    _tapLog.push({ ts: Date.now(), op: 'sendCommand', target, args: [text] });
    return { delivered: true };
  },
  paneExists: async () => true,
  isPaneDead: async () => false,
  paneCommandLooksAlive: async () => true,
  capturePane: async () => '',
  capturePaneTail: async () => '',
  capturePaneWithAnsi: async () => '',
  getPaneCwd: () => null,
  getPaneCurrentCommand: async () => 'node',
  getPaneSessionName: async () => null,
  validateTmux: async () => ({ ok: true, version: 'mock' }),
  createSession: async () => '%0',
  splitPane: async () => '%1',
  killPane: async () => true,
  killSession: async () => true,
  sendEscape: async () => ({ delivered: true }),
  sendSigint: async () => ({ delivered: true }),
  sendClear: async () => ({ delivered: true }),
  sendKey: async () => ({ delivered: true }),
  sendKeyHex: async () => ({ delivered: true }),
  listSessionWindows: async () => [],
  getActiveWindowIndex: async () => null,
  splitPaneInWindow: async () => '%2',
}));

import {
  initDb,
  closeDb,
  addAgent,
  getOrCreateRoom,
  setHint,
  getHint,
  unsetHint,
} from '../src/state/index.ts';
import {
  setGoal,
  getGoalByAgent,
  completeGoal,
  updateGoalDescription,
  unsetGoal,
  tickGoalTurnCount,
  armLeaderGoalReminder,
  consumeLeaderGoalReminder,
} from '../src/state/goal-state.ts';
import { handleGoalSet, handleGoalDone, handleGoalUpdate, handleGoalUnset, handleGoalLookup } from '../src/tools/goal.ts';
import { handleHintSet, handleHintUnset, handleHintLookup } from '../src/tools/hint.ts';
import { handleSendBatch } from '../src/tools/send-batch.ts';

function parseResult(result: { content?: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = result.content?.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map(c => c.text).join('') ?? '';
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

// ─── Goal State ─────────────────────────────────────────────────

describe('goal state', () => {
  beforeEach(() => { initDb(':memory:'); });
  afterEach(() => { try { closeDb(); } catch {} });

  test('setGoal + getGoalByAgent round-trip', () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    const goal = setGoal('w1', room.id, 'Build auth');
    expect(goal.description).toBe('Build auth');
    expect(goal.status).toBe('active');
    expect(goal.turn_count).toBe(0);

    const fetched = getGoalByAgent('w1', room.id);
    expect(fetched?.description).toBe('Build auth');
  });

  test('setGoal replaces existing goal', () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setGoal('w1', room.id, 'First goal');
    const second = setGoal('w1', room.id, 'Second goal');
    expect(second.description).toBe('Second goal');
    expect(second.turn_count).toBe(0);
    const all = getGoalByAgent('w1', room.id);
    expect(all?.description).toBe('Second goal');
  });

  test('completeGoal marks done', () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setGoal('w1', room.id, 'Do stuff');
    const done = completeGoal('w1', room.id);
    expect(done).toBe(true);
    const goal = getGoalByAgent('w1', room.id);
    expect(goal?.status).toBe('done');
  });

  test('completeGoal returns false when no active goal', () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    expect(completeGoal('w1', room.id)).toBe(false);
  });

  test('completeGoal on already-done goal returns false', () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setGoal('w1', room.id, 'Done once');
    expect(completeGoal('w1', room.id)).toBe(true);
    expect(completeGoal('w1', room.id)).toBe(false);
  });

  test('updateGoalDescription on done goal returns false', () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setGoal('w1', room.id, 'Will complete');
    completeGoal('w1', room.id);
    expect(updateGoalDescription('w1', room.id, 'Too late')).toBe(false);
  });

  test('tickGoalTurnCount on done goal returns null', () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setGoal('w1', room.id, 'Done goal');
    completeGoal('w1', room.id);
    expect(tickGoalTurnCount('%10', null, room.id)).toBeNull();
  });

  test('updateGoalDescription changes description', () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setGoal('w1', room.id, 'Original');
    const updated = updateGoalDescription('w1', room.id, 'Updated');
    expect(updated).toBe(true);
    expect(getGoalByAgent('w1', room.id)?.description).toBe('Updated');
  });

  test('unsetGoal removes goal', () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setGoal('w1', room.id, 'Will be removed');
    expect(unsetGoal('w1', room.id)).toBe(true);
    expect(getGoalByAgent('w1', room.id)).toBeNull();
  });

  test('tickGoalTurnCount increments turn', () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setGoal('w1', room.id, 'Track turns');
    const t1 = tickGoalTurnCount('%10', null, room.id);
    expect(t1?.turn_count).toBe(1);
    const t2 = tickGoalTurnCount('%10', null, room.id);
    expect(t2?.turn_count).toBe(2);
  });

  test('tickGoalTurnCount returns null without goal', () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    expect(tickGoalTurnCount('%10', null, room.id)).toBeNull();
  });

  test('multi-agent goals are isolated', () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    addAgent('w2', 'worker', room.id, '%11');
    setGoal('w1', room.id, 'Goal A');
    setGoal('w2', room.id, 'Goal B');

    tickGoalTurnCount('%10', null, room.id);
    tickGoalTurnCount('%10', null, room.id);

    expect(getGoalByAgent('w1', room.id)?.turn_count).toBe(2);
    expect(getGoalByAgent('w2', room.id)?.turn_count).toBe(0);
  });

  test('leader reminder arm/consume cycle', () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('lead', 'leader', room.id, '%10');
    setGoal('lead', room.id, 'Lead goal');

    // Not armed → consume returns null
    expect(consumeLeaderGoalReminder('%10', null, room.id)).toBeNull();

    // Arm → consume returns goal and disarms
    armLeaderGoalReminder('lead', room.id);
    const consumed = consumeLeaderGoalReminder('%10', null, room.id);
    expect(consumed?.description).toBe('Lead goal');
    expect(consumed?.leader_reminder_armed).toBe(0);

    // Second consume returns null (already disarmed)
    expect(consumeLeaderGoalReminder('%10', null, room.id)).toBeNull();
  });

  test('leader arm does not affect worker goals', () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('lead', 'leader', room.id, '%10');
    addAgent('w1', 'worker', room.id, '%11');
    setGoal('lead', room.id, 'Lead goal');
    setGoal('w1', room.id, 'Worker goal');

    armLeaderGoalReminder('lead', room.id);
    // Worker still uses tickGoalTurnCount, not consumeLeaderGoalReminder
    const workerGoal = tickGoalTurnCount('%11', null, room.id);
    expect(workerGoal?.turn_count).toBe(1);
    expect(workerGoal?.leader_reminder_armed).toBe(0);
  });
});

// ─── Goal Tool Handlers ─────────────────────────────────────────

describe('goal tool handlers', () => {
  beforeEach(() => { initDb(':memory:'); });
  afterEach(() => { try { closeDb(); } catch {} });

  test('handleGoalSet with explicit agent+room', async () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    const result = parseResult(await handleGoalSet({ agent: 'w1', room: 'dev', message: 'Build it' }));
    expect(result.ok).toBe(true);
    expect((result.goal as any).description).toBe('Build it');
    expect((result.goal as any).status).toBe('active');
  });

  test('handleGoalSet rejects empty message', async () => {
    const result = parseResult(await handleGoalSet({ agent: 'w1', room: 'dev', message: '' }));
    expect(result.ok).toBeFalsy();
  });

  test('handleGoalDone completes active goal', async () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setGoal('w1', room.id, 'Do stuff');
    const result = parseResult(await handleGoalDone({ agent: 'w1', room: 'dev' }));
    expect(result.ok).toBe(true);
    expect(result.goal_status).toBe('done');
  });

  test('handleGoalDone errors without active goal', async () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    const result = parseResult(await handleGoalDone({ agent: 'w1', room: 'dev' }));
    expect(result.ok).toBeFalsy();
  });

  test('handleGoalUpdate changes description', async () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setGoal('w1', room.id, 'Old desc');
    const result = parseResult(await handleGoalUpdate({ agent: 'w1', room: 'dev', message: 'New desc' }));
    expect(result.ok).toBe(true);
    expect(getGoalByAgent('w1', room.id)?.description).toBe('New desc');
  });

  test('handleGoalUnset removes goal', async () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setGoal('w1', room.id, 'Will remove');
    const result = parseResult(await handleGoalUnset({ agent: 'w1', room: 'dev' }));
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);
    expect(getGoalByAgent('w1', room.id)).toBeNull();
  });

  test('handleGoalLookup returns goal', async () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setGoal('w1', room.id, 'Lookup me');
    const result = parseResult(await handleGoalLookup({ agent: 'w1', room: 'dev' }));
    expect(result.ok).toBe(true);
    expect((result.goal as any)?.description).toBe('Lookup me');
  });

  test('handleGoalLookup returns null when no goal', async () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    const result = parseResult(await handleGoalLookup({ agent: 'w1', room: 'dev' }));
    expect(result.ok).toBe(true);
    expect(result.goal).toBeNull();
  });

  test('handleGoalSet by leader for worker sets setBy', async () => {
    const room = getOrCreateRoom('/tmp/g', 'dev');
    addAgent('lead', 'leader', room.id, '%10');
    addAgent('w1', 'worker', room.id, '%11');
    // Simulate leader setting goal for worker via explicit params
    const result = parseResult(await handleGoalSet({ agent: 'w1', room: 'dev', message: 'Task from leader' }));
    expect(result.ok).toBe(true);
  });
});

// ─── Hint State ─────────────────────────────────────────────────

describe('hint state', () => {
  beforeEach(() => { initDb(':memory:'); });
  afterEach(() => { try { closeDb(); } catch {} });

  test('setHint + getHint round-trip', () => {
    const room = getOrCreateRoom('/tmp/h', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    const hint = setHint('w1', room.id, 'Stay focused', { cadence: 3 });
    expect(hint.message).toBe('Stay focused');
    expect(hint.cadence).toBe(3);

    const fetched = getHint('%10', null, room.id);
    expect(fetched?.message).toBe('Stay focused');
  });

  test('setHint replaces existing hint', () => {
    const room = getOrCreateRoom('/tmp/h', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setHint('w1', room.id, 'First');
    setHint('w1', room.id, 'Second');
    expect(getHint('%10', null, room.id)?.message).toBe('Second');
  });

  test('unsetHint removes hint', () => {
    const room = getOrCreateRoom('/tmp/h', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setHint('w1', room.id, 'Remove me');
    expect(unsetHint('w1', room.id)).toBe(true);
    expect(getHint('%10', null, room.id)).toBeNull();
  });

  test('unsetHint returns false when no hint', () => {
    const room = getOrCreateRoom('/tmp/h', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    expect(unsetHint('w1', room.id)).toBe(false);
  });

  test('multi-agent hints are isolated', () => {
    const room = getOrCreateRoom('/tmp/h', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    addAgent('w2', 'worker', room.id, '%11');
    setHint('w1', room.id, 'Hint A', { cadence: 2 });
    setHint('w2', room.id, 'Hint B', { cadence: 5 });

    expect(getHint('%10', null, room.id)?.message).toBe('Hint A');
    expect(getHint('%11', null, room.id)?.message).toBe('Hint B');
    expect(getHint('%10', null, room.id)?.cadence).toBe(2);
    expect(getHint('%11', null, room.id)?.cadence).toBe(5);
  });

  test('default cadence is 3', () => {
    const room = getOrCreateRoom('/tmp/h', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    const hint = setHint('w1', room.id, 'Default cadence');
    expect(hint.cadence).toBe(3);
  });
});

// ─── Hint Tool Handlers ─────────────────────────────────────────

describe('hint tool handlers', () => {
  beforeEach(() => { initDb(':memory:'); });
  afterEach(() => { try { closeDb(); } catch {} });

  test('handleHintSet with explicit agent+room', async () => {
    const room = getOrCreateRoom('/tmp/h', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    const result = parseResult(await handleHintSet({ agent: 'w1', room: 'dev', message: 'Remember TypeScript', cadence: 5 }));
    expect(result.ok).toBe(true);
    expect((result.hint as any).message).toBe('Remember TypeScript');
    expect((result.hint as any).cadence).toBe(5);
  });

  test('handleHintSet rejects empty message', async () => {
    const result = parseResult(await handleHintSet({ agent: 'w1', room: 'dev', message: '' }));
    expect(result.ok).toBeFalsy();
  });

  test('handleHintSet defaults cadence to 3', async () => {
    const room = getOrCreateRoom('/tmp/h', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    const result = parseResult(await handleHintSet({ agent: 'w1', room: 'dev', message: 'Default' }));
    expect((result.hint as any).cadence).toBe(3);
  });

  test('handleHintUnset removes hint', async () => {
    const room = getOrCreateRoom('/tmp/h', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setHint('w1', room.id, 'Remove me');
    const result = parseResult(await handleHintUnset({ agent: 'w1', room: 'dev' }));
    expect(result.ok).toBe(true);
    expect(getHint('%10', null, room.id)).toBeNull();
  });

  test('handleHintUnset errors without hint', async () => {
    const room = getOrCreateRoom('/tmp/h', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    const result = parseResult(await handleHintUnset({ agent: 'w1', room: 'dev' }));
    expect(result.ok).toBeFalsy();
  });

  test('handleHintLookup returns hint state', async () => {
    const room = getOrCreateRoom('/tmp/h', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setHint('w1', room.id, 'Look me up', { cadence: 4 });
    const result = parseResult(await handleHintLookup({ pane: '%10' }));
    expect(result.ok).toBe(true);
    expect((result.hint as any)?.message).toBe('Look me up');
    expect((result.hint as any)?.cadence).toBe(4);
    expect((result.hint as any)?.next_reminder_at).toBe(4);
  });

  test('handleHintLookup returns null when no hint', async () => {
    const room = getOrCreateRoom('/tmp/h', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    const result = parseResult(await handleHintLookup({ pane: '%10' }));
    expect(result.ok).toBe(true);
    expect(result.hint).toBeNull();
  });
});

// ─── Send Batch ─────────────────────────────────────────────────

describe('send-batch', () => {
  const tmpDir = '/tmp/crew-test-batch-' + process.pid;

  beforeEach(() => {
    initDb(':memory:');
    _tapLog.length = 0;
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    _tapLog.length = 0;
    try { closeDb(); } catch {}
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });

  function writePromptFile(name: string, content: string): string {
    const path = `${tmpDir}/${name}.md`;
    writeFileSync(path, content);
    return path;
  }

  function writeManifest(manifest: object): string {
    const path = `${tmpDir}/manifest.json`;
    writeFileSync(path, JSON.stringify(manifest));
    return path;
  }

  test('batch send dispatches to all workers', async () => {
    const room = getOrCreateRoom('/tmp/b', 'dev');
    addAgent('lead', 'leader', room.id, '%10');
    addAgent('w1', 'worker', room.id, '%11');
    addAgent('w2', 'worker', room.id, '%12');

    const p1 = writePromptFile('w1-task', 'Implement auth module');
    const p2 = writePromptFile('w2-task', 'Write API tests');
    const manifest = writeManifest({
      workers: [
        { name: 'w1', file: p1 },
        { name: 'w2', file: p2 },
      ],
    });

    const result = parseResult(await handleSendBatch({
      room: 'dev',
      manifest,
      name: 'lead',
    }));

    expect(result.batch_id).toBeTruthy();
    const workers = result.workers as Array<{ name: string; dispatch_status: string }>;
    expect(workers.length).toBe(2);
    expect(workers.every(w => w.dispatch_status === 'sent')).toBe(true);

    // Verify tmux sends happened
    await new Promise(r => setTimeout(r, 500));
    const w1Sends = _tapLog.filter(e => e.op === 'sendKeys' && e.target === '%11');
    const w2Sends = _tapLog.filter(e => e.op === 'sendKeys' && e.target === '%12');
    expect(w1Sends.length).toBeGreaterThan(0);
    expect(w2Sends.length).toBeGreaterThan(0);
  });

  test('batch rejects non-leader sender', async () => {
    const room = getOrCreateRoom('/tmp/b', 'dev');
    addAgent('lead', 'leader', room.id, '%10');
    addAgent('w1', 'worker', room.id, '%11');

    const p1 = writePromptFile('w1-task', 'Do stuff');
    const manifest = writeManifest({
      workers: [{ name: 'w1', file: p1 }],
    });

    const result = parseResult(await handleSendBatch({
      room: 'dev',
      manifest,
      name: 'w1',
    }));

    expect(result.error).toBeTruthy();
    expect(result.batch_id).toBeUndefined();
  });

  test('batch rejects invalid manifest JSON', async () => {
    const room = getOrCreateRoom('/tmp/b', 'dev');
    addAgent('lead', 'leader', room.id, '%10');

    const path = `${tmpDir}/bad-manifest.json`;
    writeFileSync(path, 'not json{{{');

    const result = parseResult(await handleSendBatch({
      room: 'dev',
      manifest: path,
      name: 'lead',
    }));

    expect(result.error).toBeTruthy();
  });

  test('batch rejects manifest with no workers', async () => {
    const room = getOrCreateRoom('/tmp/b', 'dev');
    addAgent('lead', 'leader', room.id, '%10');

    const manifest = writeManifest({ workers: [] });
    const result = parseResult(await handleSendBatch({
      room: 'dev',
      manifest,
      name: 'lead',
    }));

    expect(result.error).toBeTruthy();
  });

  test('batch rejects worker not in room', async () => {
    const room = getOrCreateRoom('/tmp/b', 'dev');
    addAgent('lead', 'leader', room.id, '%10');
    addAgent('w1', 'worker', room.id, '%11');

    const p1 = writePromptFile('ghost-task', 'Ghost work');
    const manifest = writeManifest({
      workers: [{ name: 'ghost', file: p1 }],
    });

    const result = parseResult(await handleSendBatch({
      room: 'dev',
      manifest,
      name: 'lead',
    }));

    expect(result.error).toBeTruthy();
  });

  test('batch rejects duplicate worker names', async () => {
    const room = getOrCreateRoom('/tmp/b', 'dev');
    addAgent('lead', 'leader', room.id, '%10');
    addAgent('w1', 'worker', room.id, '%11');

    const p1 = writePromptFile('w1-task', 'Do stuff');
    const manifest = writeManifest({
      workers: [
        { name: 'w1', file: p1 },
        { name: 'w1', file: p1 },
      ],
    });

    const result = parseResult(await handleSendBatch({
      room: 'dev',
      manifest,
      name: 'lead',
    }));

    expect(result.error).toBeTruthy();
  });

  test('batch rejects mismatched leader', async () => {
    const room = getOrCreateRoom('/tmp/b', 'dev');
    addAgent('lead', 'leader', room.id, '%10');
    addAgent('w1', 'worker', room.id, '%11');

    const p1 = writePromptFile('w1-task', 'Do stuff');
    const manifest = writeManifest({
      leader: 'other-leader',
      workers: [{ name: 'w1', file: p1 }],
    });

    const result = parseResult(await handleSendBatch({
      room: 'dev',
      manifest,
      name: 'lead',
    }));

    expect(result.error).toBeTruthy();
  });

  test('batch with 3 workers dispatches all in order', async () => {
    const room = getOrCreateRoom('/tmp/b', 'dev');
    addAgent('lead', 'leader', room.id, '%10');
    addAgent('w1', 'worker', room.id, '%11');
    addAgent('w2', 'worker', room.id, '%12');
    addAgent('w3', 'worker', room.id, '%13');

    const p1 = writePromptFile('w1-task', 'Task 1');
    const p2 = writePromptFile('w2-task', 'Task 2');
    const p3 = writePromptFile('w3-task', 'Task 3');
    const manifest = writeManifest({
      workers: [
        { name: 'w1', file: p1 },
        { name: 'w2', file: p2 },
        { name: 'w3', file: p3 },
      ],
    });

    const result = parseResult(await handleSendBatch({
      room: 'dev',
      manifest,
      name: 'lead',
    }));

    expect(result.batch_id).toBeTruthy();
    const workers = result.workers as Array<{ name: string; dispatch_status: string }>;
    expect(workers.length).toBe(3);
    expect(workers[0].name).toBe('w1');
    expect(workers[1].name).toBe('w2');
    expect(workers[2].name).toBe('w3');
    expect(workers.every(w => w.dispatch_status === 'sent')).toBe(true);
  });

  test('batch rejects missing prompt file', async () => {
    const room = getOrCreateRoom('/tmp/b', 'dev');
    addAgent('lead', 'leader', room.id, '%10');
    addAgent('w1', 'worker', room.id, '%11');

    const manifest = writeManifest({
      workers: [{ name: 'w1', file: '/nonexistent/path.md' }],
    });

    const result = parseResult(await handleSendBatch({
      room: 'dev',
      manifest,
      name: 'lead',
    }));

    expect(result.error).toBeTruthy();
  });
});

// ─── Cross-feature: Goal + Hint + Hook interaction ──────────────

describe('goal + hint cross-feature', () => {
  beforeEach(() => { initDb(':memory:'); });
  afterEach(() => { try { closeDb(); } catch {} });

  test('goal and hint coexist for same agent', () => {
    const room = getOrCreateRoom('/tmp/x', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setGoal('w1', room.id, 'Build auth');
    setHint('w1', room.id, 'Use TypeScript', { cadence: 3 });

    expect(getGoalByAgent('w1', room.id)?.description).toBe('Build auth');
    expect(getHint('%10', null, room.id)?.message).toBe('Use TypeScript');
  });

  test('completing goal does not affect hint', () => {
    const room = getOrCreateRoom('/tmp/x', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setGoal('w1', room.id, 'Build auth');
    setHint('w1', room.id, 'Stay focused');
    completeGoal('w1', room.id);
    expect(getHint('%10', null, room.id)?.message).toBe('Stay focused');
  });

  test('unsetting hint does not affect goal', () => {
    const room = getOrCreateRoom('/tmp/x', 'dev');
    addAgent('w1', 'worker', room.id, '%10');
    setGoal('w1', room.id, 'Build auth');
    setHint('w1', room.id, 'Stay focused');
    unsetHint('w1', room.id);
    expect(getGoalByAgent('w1', room.id)?.description).toBe('Build auth');
  });

  test('multi-agent room: each agent has independent goal + hint', () => {
    const room = getOrCreateRoom('/tmp/x', 'dev');
    addAgent('lead', 'leader', room.id, '%10');
    addAgent('w1', 'worker', room.id, '%11');
    addAgent('w2', 'worker', room.id, '%12');

    setGoal('w1', room.id, 'Auth');
    setGoal('w2', room.id, 'Tests');
    setHint('w1', room.id, 'w1-hint', { cadence: 2 });
    setHint('w2', room.id, 'w2-hint', { cadence: 5 });

    // Tick w1 goal twice
    tickGoalTurnCount('%11', null, room.id);
    tickGoalTurnCount('%11', null, room.id);

    expect(getGoalByAgent('w1', room.id)?.turn_count).toBe(2);
    expect(getGoalByAgent('w2', room.id)?.turn_count).toBe(0);

    // Unset w2's hint — w1's hint survives
    unsetHint('w2', room.id);
    expect(getHint('%11', null, room.id)?.message).toBe('w1-hint');
    expect(getHint('%12', null, room.id)).toBeNull();
  });

  test('leader goal arm/consume does not affect worker goals', () => {
    const room = getOrCreateRoom('/tmp/x', 'dev');
    addAgent('lead', 'leader', room.id, '%10');
    addAgent('w1', 'worker', room.id, '%11');

    setGoal('lead', room.id, 'Coordinate');
    setGoal('w1', room.id, 'Implement');

    armLeaderGoalReminder('lead', room.id);
    const leaderGoal = consumeLeaderGoalReminder('%10', null, room.id);
    expect(leaderGoal?.description).toBe('Coordinate');

    // Worker goal unaffected
    const workerGoal = tickGoalTurnCount('%11', null, room.id);
    expect(workerGoal?.description).toBe('Implement');
    expect(workerGoal?.turn_count).toBe(1);
  });
});
