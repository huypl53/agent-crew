/**
 * Tests for hook-event hint reminder emission via formatter and hint CLI.
 *
 * The crew plugin's `crew hook-event` runs on UserPromptSubmit. It has two
 * hint paths:
 *
 * 1. **Hint injection** (model context): on cadence turns, emit the hint
 *    message to stdout. Claude Code injects this as <system-reminder> context
 *    visible only to the model.
 *
 * 2. **User output stays quiet**: `hook-event` should not write hint text to
 *    stderr or show a user-visible notice.
 *
 * Cadence logic is covered in state.test.ts. These tests verify the
 * formatter contract, hook-event dual-path output, hint CLI room scoping,
 * and read-only lookup.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { formatResult } from '../src/cli/formatter.ts';
import { COMMANDS } from '../src/cli/router.ts';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  addAgent,
  clearState,
  getHint,
  getOrCreateRoom,
  setHint,
  tickHintCadence,
} from '../src/state/index.ts';
import {
  handleHintLookup,
  handleHintSet,
  handleHintUnset,
} from '../src/tools/hint.ts';
import { processHookEventInput } from '../src/tools/hook-event.ts';

function parseResult(
  result:
    | Awaited<ReturnType<typeof handleHintSet>>
    | Awaited<ReturnType<typeof handleHintUnset>>
    | Awaited<ReturnType<typeof handleHintLookup>>,
) {
  return JSON.parse(result.content[0]!.text);
}

async function runHookEventCli(input: string, pane: string) {
  const crewDir = path.resolve(new URL('..', import.meta.url).pathname);
  const cliPath = path.resolve(crewDir, 'src/cli.ts');
  const stateDir = process.env.CREW_STATE_DIR;

  const proc = Bun.spawn(['bun', cliPath, 'hook-event'], {
    stdin: new Response(input),
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: crewDir,
    env: {
      ...process.env,
      ...(stateDir ? { CREW_STATE_DIR: stateDir } : {}),
      TMUX_PANE: pane,
    },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe('hook-event formatter (hint reminder emission)', () => {
  test('passes through hint message when present', () => {
    const message =
      'You are worker-1 in project-x. Check inbox before responding.';
    const out = formatResult('hook-event', {
      ok: true,
      hint: { agent_name: 'worker-1', message },
    });
    expect(out).toBe(message);
  });

  test('stays silent when no hint is due', () => {
    const out = formatResult('hook-event', { ok: true });
    expect(out).toBe('');
  });

  test('stays silent when hint lacks message', () => {
    const out = formatResult('hook-event', {
      ok: true,
      hint: { agent_name: 'alice' },
    });
    expect(out).toBe('');
  });
});

describe('hook-event dual-path (processHookEventInput)', () => {
  beforeEach(() => {
    process.env.CREW_STATE_DIR = `/tmp/crew-hook-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    initDb();
    clearState();
  });

  afterEach(() => {
    closeDb();
    delete process.env.CREW_STATE_DIR;
    delete process.env.TMUX_PANE;
  });

  test('cadence turn: returns hint for model context', async () => {
    const room = getOrCreateRoom('/test/room', 'room');
    addAgent('worker-1', 'worker', room.id, '%400');
    setHint('worker-1', room.id, 'You are worker-1 in project-x.', {
      pane: '%400',
      cadence: 3,
    });

    // Advance to turn 3 (cadence fires)
    tickHintCadence('%400', null, room.id); // turn 1
    tickHintCadence('%400', null, room.id); // turn 2
    // turn 3 will be the cadence turn

    const input = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-1',
    });
    const result = await processHookEventInput(input, '%400');
    const data = JSON.parse(result.content[0]!.text);

    // Model context: full hint message
    expect(data.hint).toBeDefined();
    expect(data.hint.agent_name).toBe('worker-1');
    expect(data.hint.message).toBe('You are worker-1 in project-x.');
    expect(data.hintStatus).toBeUndefined();
  });

  test('non-cadence turn: no model context injection', async () => {
    const room = getOrCreateRoom('/test/room', 'room');
    addAgent('worker-1', 'worker', room.id, '%401');
    setHint('worker-1', room.id, 'You are worker-1 in project-x.', {
      pane: '%401',
      cadence: 3,
    });

    // Turn 1: not a cadence turn
    const input = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-2',
    });
    const result = await processHookEventInput(input, '%401');
    const data = JSON.parse(result.content[0]!.text);

    expect(data.hint).toBeUndefined();
    expect(data.hintStatus).toBeUndefined();
  });

  test('no hint: returns neither hint nor hintStatus', async () => {
    const room = getOrCreateRoom('/test/room', 'room');
    addAgent('worker-1', 'worker', room.id, '%402');
    // No hint set

    const input = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-3',
    });
    const result = await processHookEventInput(input, '%402');
    const data = JSON.parse(result.content[0]!.text);

    expect(data.ok).toBe(true);
    expect(data.hint).toBeUndefined();
    expect(data.hintStatus).toBeUndefined();
  });

  test('hint message stays out of user-visible status fields', async () => {
    const room = getOrCreateRoom('/test/room', 'room');
    addAgent('worker-1', 'worker', room.id, '%403');
    const longMessage = 'A'.repeat(50);
    setHint('worker-1', room.id, longMessage, { pane: '%403', cadence: 3 });

    const input = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-4',
    });
    const result = await processHookEventInput(input, '%403');
    const data = JSON.parse(result.content[0]!.text);

    expect(data.hint).toBeUndefined();
    expect(data.hintStatus).toBeUndefined();
  });

  test('CLI writes hint message to stdout and keeps stderr silent', async () => {
    const room = getOrCreateRoom('/test/room', 'room');
    addAgent('worker-1', 'worker', room.id, '%405');
    setHint('worker-1', room.id, 'You are worker-1 in project-x.', {
      pane: '%405',
      cadence: 3,
    });

    tickHintCadence('%405', null, room.id);
    tickHintCadence('%405', null, room.id);

    const input = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-6',
    });
    const { stdout, stderr, exitCode } = await runHookEventCli(input, '%405');

    expect(stdout.trim()).toBe('You are worker-1 in project-x.');
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });
});

describe('hint command room scoping', () => {
  beforeEach(() => {
    process.env.CREW_STATE_DIR = `/tmp/crew-hint-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    initDb();
    clearState();
  });

  afterEach(() => {
    closeDb();
    delete process.env.CREW_STATE_DIR;
    delete process.env.TMUX_PANE;
  });

  test('handleHintSet errors when message is missing', async () => {
    const result = await handleHintSet({ agent: 'lead-1', room: 'company' });
    const data = parseResult(result);

    expect(result.isError).toBe(true);
    expect(data.error).toContain('Message is required');
  });

  test('handleHintSet accepts custom message and cadence', async () => {
    const company = getOrCreateRoom('/test/company', 'company');
    addAgent('lead-1', 'leader', company.id, '%210');
    process.env.TMUX_PANE = '%210';

    const result = await handleHintSet({
      message: 'You are lead-1 in company.',
      cadence: 1,
    });
    const data = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(data.hint.agent_name).toBe('lead-1');
    expect(data.hint.cadence).toBe(1);
    expect(data.hint.message).toBe('You are lead-1 in company.');
    expect(data.hint.status).toContain('every 1 turn');
  });

  test('handleHintSet rejects invalid cadence', async () => {
    const company = getOrCreateRoom('/test/company', 'company');
    addAgent('lead-1', 'leader', company.id, '%211');
    process.env.TMUX_PANE = '%211';

    const result = await handleHintSet({ message: 'Test', cadence: 0 });
    const data = parseResult(result);

    expect(result.isError).toBe(true);
    expect(data.error).toContain('-c/--cadence must be a positive integer');
  });

  test('handleHintSet resolves the agent inside the requested room', async () => {
    const company = getOrCreateRoom('/test/company', 'company');
    const frontend = getOrCreateRoom('/test/frontend', 'frontend');
    addAgent('lead-1', 'leader', company.id, '%201');
    addAgent('lead-1', 'leader', frontend.id, '%202');

    const result = await handleHintSet({
      agent: 'lead-1',
      room: 'company',
      message: 'You are lead in company.',
    });
    const data = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(data.hint.agent_name).toBe('lead-1');
    expect(data.hint.room_id).toBe(company.id);
    expect(data.hint.room_name).toBe('company');
    expect(data.hint.pane_bootstrap).toBe('%201');
  });

  test('handleHintSet auto-detects current agent from TMUX_PANE', async () => {
    const company = getOrCreateRoom('/test/company', 'company');
    addAgent('lead-1', 'leader', company.id, '%203');
    process.env.TMUX_PANE = '%203';

    const result = await handleHintSet({ message: 'Auto-detected agent.' });
    const data = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(data.hint.agent_name).toBe('lead-1');
    expect(data.hint.room_id).toBe(company.id);
    expect(data.hint.room_name).toBe('company');
    expect(data.hint.pane_bootstrap).toBe('%203');
  });

  test('handleHintUnset auto-detects current agent from TMUX_PANE', async () => {
    const company = getOrCreateRoom('/test/company', 'company');
    addAgent('lead-1', 'leader', company.id, '%204');
    process.env.TMUX_PANE = '%204';

    const setResult = await handleHintSet({ message: 'Test message' });
    expect(setResult.isError).toBeUndefined();
    expect(getHint('%204', null)?.agent_name).toBe('lead-1');

    const unsetResult = await handleHintUnset({});
    const data = parseResult(unsetResult);

    expect(unsetResult.isError).toBeUndefined();
    expect(data.message).toContain('Hint removed for lead-1 in company');
    expect(getHint('%204', null)).toBeNull();
  });

  test('handleHintSet errors clearly when no current agent can be inferred', async () => {
    const result = await handleHintSet({ message: 'Test' });
    const data = parseResult(result);

    expect(result.isError).toBe(true);
    expect(data.error).toContain('No registered agent found for current pane');
  });

  test('handleHintSet errors when room not found', async () => {
    const result = await handleHintSet({
      agent: 'lead-1',
      room: 'nonexistent',
      message: 'Test',
    });
    const data = parseResult(result);

    expect(result.isError).toBe(true);
    expect(data.error).toContain('Room not found');
  });

  test('handleHintSet errors when agent not in room', async () => {
    const _company = getOrCreateRoom('/test/company', 'company');
    // No agent registered in company room

    const result = await handleHintSet({
      agent: 'ghost',
      room: 'company',
      message: 'Test',
    });
    const data = parseResult(result);

    expect(result.isError).toBe(true);
    expect(data.error).toContain('Agent ghost is not in room company');
  });
});

describe('hint lookup (read-only)', () => {
  beforeEach(() => {
    process.env.CREW_STATE_DIR = `/tmp/crew-hint-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    initDb();
    clearState();
  });

  afterEach(() => {
    closeDb();
    delete process.env.CREW_STATE_DIR;
    delete process.env.TMUX_PANE;
  });

  test('handleHintLookup returns hint without advancing cadence', async () => {
    const room = getOrCreateRoom('/test/room', 'room');
    addAgent('worker-1', 'worker', room.id, '%300');
    process.env.TMUX_PANE = '%300';

    await handleHintSet({ message: 'You are worker-1.' });

    // Lookup is read-only — turn_count stays at 0
    const result = await handleHintLookup({ pane: '%300' });
    const data = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(data.hint.agent_name).toBe('worker-1');
    expect(data.hint.turn_count).toBe(0);
    expect(data.hint.next_reminder_at).toBe(3);
    expect(data.hint.message).toBe('You are worker-1.');
    expect(data.hint.cadence).toBe(3);

    // Verify turn_count was NOT incremented
    const hintAfter = getHint('%300', null);
    expect(hintAfter?.turn_count).toBe(0);
  });

  test('handleHintLookup returns null when no hint exists', async () => {
    const result = await handleHintLookup({ pane: '%999' });
    const data = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(data.hint).toBeNull();
  });

  test('handleHintLookup errors without pane', async () => {
    delete process.env.TMUX_PANE;
    const result = await handleHintLookup({});
    const data = parseResult(result);

    expect(result.isError).toBe(true);
    expect(data.error).toContain('Pane is required');
  });
});

describe('hint subcommand routing', () => {
  test('returns isError=true for missing subcommand', async () => {
    const hintCommand = COMMANDS.hint;
    expect(hintCommand).toBeDefined();
    const params = hintCommand!.buildParams({}, []);
    const result = await hintCommand!.handler(params);
    const data = JSON.parse(result.content[0]!.text);

    expect(result.isError).toBe(true);
    expect(data.error).toContain('Unknown hint subcommand');
    expect(data.error).toContain('set, unset, lookup');
  });

  test('returns isError=true for invalid subcommand', async () => {
    const hintCommand = COMMANDS.hint;
    expect(hintCommand).toBeDefined();
    const params = hintCommand!.buildParams({}, ['bogus']);
    const result = await hintCommand!.handler(params);
    const data = JSON.parse(result.content[0]!.text);

    expect(result.isError).toBe(true);
    expect(data.error).toContain("'bogus'");
    expect(data.error).toContain('set, unset, lookup');
  });
});
