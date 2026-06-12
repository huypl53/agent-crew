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
});
