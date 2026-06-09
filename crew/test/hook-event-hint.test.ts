/**
 * Tests for hook-event hint reminder emission via formatter and hint CLI.
 *
 * The crew plugin's `crew hook-event` runs on UserPromptSubmit. When a hint
 * is registered and the cadence counter hits a multiple of the configured
 * cadence (default 3), the handler returns `{ ok: true, hint: { agent_name,
 * message } }` and the formatter emits the user-defined message to stdout.
 * Claude Code injects that stdout into the conversation as context.
 *
 * Cadence logic is covered in state.test.ts. These tests verify the
 * formatter contract, hint CLI room scoping, and read-only lookup.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { formatResult } from '../src/cli/formatter.ts';
import { COMMANDS } from '../src/cli/router.ts';
import { closeDb, getDb, initDb } from '../src/state/db.ts';
import {
  addAgent,
  clearState,
  getHint,
  getOrCreateRoom,
} from '../src/state/index.ts';
import {
  handleHintLookup,
  handleHintSet,
  handleHintUnset,
} from '../src/tools/hint.ts';

function parseResult(
  result:
    | Awaited<ReturnType<typeof handleHintSet>>
    | Awaited<ReturnType<typeof handleHintUnset>>
    | Awaited<ReturnType<typeof handleHintLookup>>,
) {
  return JSON.parse(result.content[0]?.text);
}

describe('hook-event formatter (hint reminder emission)', () => {
  test('passes through user message verbatim', () => {
    const message =
      'You are worker-1 in project-x. Check inbox before responding.';
    const out = formatResult('hook-event', {
      ok: true,
      hint: { agent_name: 'worker-1', message },
    });
    expect(out).toBe(message);
  });

  test('stays silent (empty string) when no hint is due', () => {
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

  test('handleHintLookup errors without pane and session', async () => {
    delete process.env.TMUX_PANE;
    const result = await handleHintLookup({});
    const data = parseResult(result);

    expect(result.isError).toBe(true);
    expect(data.error).toContain('Either session (--session) or pane');
  });

  test('handleHintLookup supports session ID lookup without pane', async () => {
    delete process.env.TMUX_PANE;
    const room = getOrCreateRoom('/test/room', 'room');
    addAgent('worker-1', 'worker', room.id, '%300');

    // Set hint
    await handleHintSet({
      agent: 'worker-1',
      room: 'room',
      message: 'Session hint.',
    });

    // Update agent_hints directly to simulate session mapping
    const db = getDb();
    db.run(
      "UPDATE agent_hints SET session_id = 'session-999' WHERE agent_name = 'worker-1'",
    );

    const result = await handleHintLookup({ session: 'session-999' });
    const data = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(data.hint.agent_name).toBe('worker-1');
    expect(data.hint.message).toBe('Session hint.');
  });
});

describe('hint subcommand routing', () => {
  test('returns isError=true for missing subcommand', async () => {
    const params = COMMANDS.hint.buildParams({}, []);
    const result = await COMMANDS.hint.handler(params);
    const data = JSON.parse(result.content[0]?.text);

    expect(result.isError).toBe(true);
    expect(data.error).toContain('Unknown hint subcommand');
    expect(data.error).toContain('set, unset, lookup');
  });

  test('returns isError=true for invalid subcommand', async () => {
    const params = COMMANDS.hint.buildParams({}, ['bogus']);
    const result = await COMMANDS.hint.handler(params);
    const data = JSON.parse(result.content[0]?.text);

    expect(result.isError).toBe(true);
    expect(data.error).toContain("'bogus'");
    expect(data.error).toContain('set, unset, lookup');
  });
});
