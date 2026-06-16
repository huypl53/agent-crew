import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  cleanupAllTestSessions,
  createTestSession,
  destroyTestSession,
} from './helpers.ts';

const CLI_CWD = resolve(import.meta.dir, '..');

// --- Test helpers ---

async function runCli(
  args: string[],
  env?: Record<string, string>,
  stdin?: string,
): Promise<{ out: string; err: string; exitCode: number }> {
  const proc = Bun.spawn(['bun', 'src/cli.ts', ...args], {
    cwd: CLI_CWD,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: stdin ? 'pipe' : undefined,
    env: env ? { ...process.env, ...env } : undefined,
  });
  if (stdin && proc.stdin) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  return { out, err, exitCode: proc.exitCode };
}

/** Simulate a hook event (UserPromptSubmit or Stop) for a registered agent. */
function hookPayload(
  eventType: 'UserPromptSubmit' | 'Stop',
  sessionId: string,
): string {
  return JSON.stringify({
    hook_event_name: eventType,
    session_id: sessionId,
  });
}

// --- Suite ---

describe('goal feature e2e — CLI', () => {
  let stateDir: string;
  let leaderSession: { session: string; pane: string };
  let workerSession: { session: string; pane: string };

  const env = () => ({
    CREW_STATE_DIR: stateDir,
    CREW_TMUX_SOCKET: process.env.CREW_TMUX_SOCKET!,
  });

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'crew-goal-e2e-'));
    process.env.CREW_STATE_DIR = stateDir;

    leaderSession = await createTestSession('leader');
    workerSession = await createTestSession('worker');

    // Register leader
    const leaderJoin = await runCli(
      ['join', '--room', 'goal-room', '--role', 'leader', '--name', 'lead-1', '--pane', leaderSession.pane],
      env(),
    );
    expect(leaderJoin.exitCode).toBe(0);

    // Register worker
    const workerJoin = await runCli(
      ['join', '--room', 'goal-room', '--role', 'worker', '--name', 'wk-1', '--pane', workerSession.pane],
      env(),
    );
    expect(workerJoin.exitCode).toBe(0);
  });

  afterAll(async () => {
    await destroyTestSession('leader');
    await destroyTestSession('worker');
    await cleanupAllTestSessions();
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.CREW_STATE_DIR;
  });

  // 1. Worker sets own goal
  test('goal set creates active goal', async () => {
    const { out, exitCode } = await runCli(
      ['goal', 'set', 'Implement auth module', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      env(),
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.goal.description).toBe('Implement auth module');
    expect(data.goal.status).toBe('active');
    expect(data.goal.turn_count).toBe(0);
  });

  // 2. Lookup by agent
  test('goal lookup finds goal by agent name', async () => {
    const { out, exitCode } = await runCli(
      ['goal', 'lookup', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      env(),
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.goal).not.toBeNull();
    expect(data.goal.description).toBe('Implement auth module');
  });

  // 3. Leader sets goal for worker (setBy detection)
  test('goal set by leader detects setBy', async () => {
    // Leader pane sets goal for worker — TMUX_PANE=leader pane → resolves to lead-1
    const { out, exitCode } = await runCli(
      ['goal', 'set', 'Fix bug #42', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      { ...env(), TMUX_PANE: leaderSession.pane },
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.goal.description).toBe('Fix bug #42');

    // Verify setBy via lookup
    const lookup = await runCli(
      ['goal', 'lookup', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      env(),
    );
    const goal = JSON.parse(lookup.out).goal;
    expect(goal.set_by).toBe('lead-1');
  });

  // 4. Update goal description
  test('goal update changes description', async () => {
    const { out, exitCode } = await runCli(
      ['goal', 'update', 'Fix bug #42 in auth.ts', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      env(),
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(out).goal.description).toBe('Fix bug #42 in auth.ts');
  });

  // 5. Goal appears in status --self --json
  test('goal appears in status dashboard', async () => {
    const { out, exitCode } = await runCli(
      ['status', '--self', '--name', 'wk-1', '--json'],
      env(),
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.goal).not.toBeNull();
    expect(data.goal.description).toBe('Fix bug #42 in auth.ts');
    expect(data.goal.status).toBe('active');
  });

  // 6. Stop hook ticks turn_count for active goal
  test('Stop hook ticks turn_count for active goal', async () => {
    // Fire Stop event for worker — TMUX_PANE must match registered agent
    const { exitCode } = await runCli(
      ['hook-event'],
      { ...env(), TMUX_PANE: workerSession.pane },
      hookPayload('Stop', 'sess-wk-1'),
    );
    expect(exitCode).toBe(0);

    // Verify turn_count incremented (DB-level, reliable)
    const { out } = await runCli(
      ['goal', 'lookup', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      env(),
    );
    const goal = JSON.parse(out).goal;
    expect(goal.turn_count).toBeGreaterThanOrEqual(1);
  });

  // 8. Canonicalization via UserPromptSubmit hook
  test('UserPromptSubmit canonicalizes goal identity', async () => {
    // Fire UserPromptSubmit with session_id — triggers canonicalizeGoalIdentity
    const { exitCode } = await runCli(
      ['hook-event'],
      { ...env(), TMUX_PANE: workerSession.pane },
      hookPayload('UserPromptSubmit', 'sess-canonical'),
    );
    expect(exitCode).toBe(0);

    // Goal should now be findable by session_id
    const { out, exitCode: lc } = await runCli(
      ['goal', 'lookup', '--session', 'sess-canonical', '--json'],
      env(),
    );
    expect(lc).toBe(0);
    const data = JSON.parse(out);
    expect(data.goal).not.toBeNull();
    expect(data.goal.session_id).toBe('sess-canonical');
  });

  // 9. Complete goal
  test('goal done marks as done', async () => {
    const { out, exitCode } = await runCli(
      ['goal', 'done', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      env(),
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(out).goal_status).toBe('done');

    // Lookup shows done status
    const lookup = await runCli(
      ['goal', 'lookup', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      env(),
    );
    const goal = JSON.parse(lookup.out).goal;
    expect(goal.status).toBe('done');
    expect(goal.completed_at).not.toBeNull();
  });

  // 10. Done goals don't tick on Stop
  test('tick does not increment done goals', async () => {
    const beforeLookup = await runCli(
      ['goal', 'lookup', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      env(),
    );
    const turnCountBefore = JSON.parse(beforeLookup.out).goal.turn_count;

    // Fire Stop — should NOT tick done goal
    await runCli(
      ['hook-event'],
      { ...env(), TMUX_PANE: workerSession.pane },
      hookPayload('Stop', 'sess-wk-1'),
    );

    const afterLookup = await runCli(
      ['goal', 'lookup', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      env(),
    );
    const turnCountAfter = JSON.parse(afterLookup.out).goal.turn_count;
    expect(turnCountAfter).toBe(turnCountBefore);
  });

  // 11. Unset removes goal entirely
  test('goal unset removes goal', async () => {
    // Set a fresh goal first
    await runCli(
      ['goal', 'set', 'Temporary goal', '--agent', 'wk-1', '--room', 'goal-room'],
      env(),
    );

    // Unset it
    const { out, exitCode } = await runCli(
      ['goal', 'unset', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      env(),
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(out).removed).toBe(true);

    // Lookup returns null
    const lookup = await runCli(
      ['goal', 'lookup', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      env(),
    );
    expect(JSON.parse(lookup.out).goal).toBeNull();
  });

  // 12. Default `crew goal` (no subcommand) shows room overview
  test('crew goal (no subcommand) shows room overview', async () => {
    // Seed a fresh goal so there is something to show
    await runCli(
      ['goal', 'set', 'Overview seed goal', '--agent', 'wk-1', '--room', 'goal-room'],
      env(),
    );

    const { out, exitCode } = await runCli(
      ['goal', '--room', 'goal-room', '--json'],
      env(),
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.overview).toBe(true);
    expect(data.room).toBe('goal-room');
    const wkGoal = data.goals.find((g: any) => g.agent_name === 'wk-1');
    expect(wkGoal).toBeDefined();
    expect(wkGoal.description).toBe('Overview seed goal');
  });

  // 13. `crew goal history` lists past goals with ids
  test('crew goal history lists goals with ids', async () => {
    const { out, exitCode } = await runCli(
      ['goal', 'history', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      env(),
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.history).toBe(true);
    expect(Array.isArray(data.goals)).toBe(true);
    expect(data.goals.length).toBeGreaterThan(0);
    // Every history entry carries an id (needed for `goal redo`)
    for (const g of data.goals) {
      expect(typeof g.id).toBe('number');
    }
  });

  // 14. `crew goal redo <id>` reactivates a past goal by id
  test('crew goal redo reactivates a past goal by id', async () => {
    // First, complete the current goal so we have something non-active to redo
    await runCli(
      ['goal', 'done', '--agent', 'wk-1', '--room', 'goal-room'],
      env(),
    );

    // Fetch an id from history
    const hist = await runCli(
      ['goal', 'history', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      env(),
    );
    const doneGoal = JSON.parse(hist.out).goals.find(
      (g: any) => g.status !== 'active',
    );
    expect(doneGoal).toBeDefined();

    // Redo it
    const { out, exitCode } = await runCli(
      ['goal', 'redo', String(doneGoal.id), '--room', 'goal-room', '--json'],
      env(),
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(out);
    expect(data.goal.status).toBe('active');
    expect(data.goal.redone_from).toBe(doneGoal.id);
    expect(data.goal.description).toBe(doneGoal.description);
  });

  // 15. `crew goal redo` rejects an unknown id
  test('crew goal redo rejects unknown id', async () => {
    // goal id 999999 won't exist at all → not found, exitCode 1
    const { out, err, exitCode } = await runCli(
      ['goal', 'redo', '999999', '--room', 'goal-room', '--json'],
      env(),
    );
    expect(exitCode).toBe(1);
    const blob = (out || err || '').toLowerCase();
    expect(blob).toContain('999999'); // echoes the offending id
  });

  // 16. `crew goal redo` binds the reactivated goal to the TARGET agent's pane,
  // not the caller's pane (regression: H1 — redo used to leak the operator pane).
  test('crew goal redo binds to target agent pane, not caller pane', async () => {
    // Seed + complete a goal for the worker so we have a redo candidate
    await runCli(
      ['goal', 'set', 'Pane-binding redo', '--agent', 'wk-1', '--room', 'goal-room'],
      env(),
    );
    await runCli(['goal', 'done', '--agent', 'wk-1', '--room', 'goal-room'], env());

    const hist = await runCli(
      ['goal', 'history', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      env(),
    );
    const candidate = JSON.parse(hist.out).goals.find(
      (g: any) => g.description === 'Pane-binding redo' && g.status !== 'active',
    );
    expect(candidate).toBeDefined();

    // Redo it FROM the LEADER's pane (not the worker's). The reactivated goal
    // must be bound to the worker's pane, not the leader's.
    await runCli(
      ['goal', 'redo', String(candidate.id), '--room', 'goal-room'],
      { ...env(), TMUX_PANE: leaderSession.pane },
    );

    // Lookup the worker's goal by agent → its pane must be the worker's pane
    const { out } = await runCli(
      ['goal', 'lookup', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      env(),
    );
    const goal = JSON.parse(out).goal;
    expect(goal.pane_bootstrap).toBe(workerSession.pane);
    expect(goal.pane_bootstrap).not.toBe(leaderSession.pane);
  });

  // 17. `crew goal redo` on an already-active goal is a no-op (no history churn)
  test('crew goal redo on active goal is a no-op', async () => {
    // wk-1 currently has an active goal from the previous test
    const before = await runCli(
      ['goal', 'history', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      env(),
    );
    const activeGoal = JSON.parse(before.out).goals.find(
      (g: any) => g.status === 'active',
    );
    expect(activeGoal).toBeDefined();
    const countBefore = JSON.parse(before.out).goals.length;

    const { out, exitCode } = await runCli(
      ['goal', 'redo', String(activeGoal.id), '--room', 'goal-room', '--json'],
      env(),
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(out).goal.status).toBe('active');

    // History count unchanged — no retired+re-inserted duplicate
    const after = await runCli(
      ['goal', 'history', '--agent', 'wk-1', '--room', 'goal-room', '--json'],
      env(),
    );
    expect(JSON.parse(after.out).goals.length).toBe(countBefore);
  });
});
