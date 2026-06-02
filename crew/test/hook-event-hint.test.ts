/**
 * Tests for hook-event hint reminder emission via formatter and hint CLI.
 *
 * The crew plugin's `crew hook-event` runs on UserPromptSubmit. When a hint
 * is registered and the cadence counter hits a multiple of 3, the handler
 * returns `{ ok: true, hint: { agent_name, message } }` and the formatter
 * emits the reminder text to stdout. Claude Code injects that stdout into
 * the conversation as context.
 *
 * Cadence logic is covered in state.test.ts. These tests verify the
 * formatter contract, hint CLI room scoping, and read-only lookup.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { formatResult } from '../src/cli/formatter.ts';
import { closeDb, initDb } from '../src/state/db.ts';
import { addAgent, clearState, getHint, getOrCreateRoom, setHint } from '../src/state/index.ts';
import { handleHintLookup, handleHintSet, handleHintUnset } from '../src/tools/hint.ts';

function parseResult(
  result: Awaited<ReturnType<typeof handleHintSet>> | Awaited<ReturnType<typeof handleHintUnset>> | Awaited<ReturnType<typeof handleHintLookup>>,
) {
  return JSON.parse(result.content[0]!.text);
}

describe('hook-event formatter (hint reminder emission)', () => {
  test('emits reminder message when hint is due', () => {
    const message =
      '[crew] Registered as agent "alice". Run `crew hint unset` from this pane to clear.';
    const out = formatResult('hook-event', {
      ok: true,
      hint: { agent_name: 'alice', message },
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

  test('sanitizes control characters in agent name', () => {
    const message =
      '[crew] Registered as agent "bad\\nagent". Run `crew hint unset` from this pane to clear.';
    const out = formatResult('hook-event', {
      ok: true,
      hint: { agent_name: 'bad\nagent', message },
    });
    // The message still contains the raw name; sanitization happens in hook-event.ts
    // before constructing the message. This test verifies the formatter passes it through.
    expect(out).toBe(message);
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

  test('handleHintSet resolves the agent inside the requested room', async () => {
    const company = getOrCreateRoom('/test/company', 'company');
    const frontend = getOrCreateRoom('/test/frontend', 'frontend');
    addAgent('lead-1', 'leader', company.id, '%201');
    addAgent('lead-1', 'leader', frontend.id, '%202');

    const result = await handleHintSet({ agent: 'lead-1', room: 'company' });
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

    const result = await handleHintSet({});
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

    const setResult = await handleHintSet({});
    expect(setResult.isError).toBeUndefined();
    expect(getHint('%204', null)?.agent_name).toBe('lead-1');

    const unsetResult = await handleHintUnset({});
    const data = parseResult(unsetResult);

    expect(unsetResult.isError).toBeUndefined();
    expect(data.message).toContain('Hint removed for lead-1 in company');
    expect(getHint('%204', null)).toBeNull();
  });

  test('handleHintSet errors clearly when no current agent can be inferred', async () => {
    const result = await handleHintSet({});
    const data = parseResult(result);

    expect(result.isError).toBe(true);
    expect(data.error).toContain('No registered agent found for current pane');
  });

  test('handleHintSet errors when room not found', async () => {
    const result = await handleHintSet({ agent: 'lead-1', room: 'nonexistent' });
    const data = parseResult(result);

    expect(result.isError).toBe(true);
    expect(data.error).toContain('Room not found');
  });

  test('handleHintSet errors when agent not in room', async () => {
    const company = getOrCreateRoom('/test/company', 'company');
    // No agent registered in company room

    const result = await handleHintSet({ agent: 'ghost', room: 'company' });
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

    await handleHintSet({});

    // Lookup is read-only — turn_count stays at 0
    const result = await handleHintLookup({ pane: '%300' });
    const data = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(data.hint.agent_name).toBe('worker-1');
    expect(data.hint.turn_count).toBe(0);
    expect(data.hint.next_reminder_at).toBe(3);

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
