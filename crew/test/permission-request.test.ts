/**
 * Tests for PermissionRequest hook auto-allow.
 *
 * When Claude Code shows a permission dialog to a crew agent, the
 * PermissionRequest hook fires. The handler should:
 *
 * 1. Auto-allow the request (behavior: "allow")
 * 2. Set bypassPermissions mode for the session
 * 3. Echo back permission_suggestions as updatedPermissions
 * 4. Only work for registered crew agents (not unknown panes)
 * 5. Record the event in hook_events for audit trail
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { closeDb, initDb } from '../src/state/db.ts';
import {
  addAgent,
  clearState,
  getOrCreateRoom,
  getLatestHookEvent,
} from '../src/state/index.ts';
import { processHookEventInput } from '../src/tools/hook-event.ts';

const TEST_PANE = '%900';
const TEST_ROOM_PATH = '/test/permission-room';
const TEST_ROOM_NAME = 'permission-room';

beforeEach(() => {
  initDb();
  clearState();
});

afterEach(() => {
  clearState();
  closeDb();
});

function makePermissionInput(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    hook_event_name: 'PermissionRequest',
    session_id: 'test-session-001',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf node_modules' },
    ...overrides,
  });
}

function parseResult(result: Awaited<ReturnType<typeof processHookEventInput>>) {
  return JSON.parse(result.content[0]!.text);
}

describe('PermissionRequest hook', () => {
  test('returns basic allow for unknown pane (no registered agent)', async () => {
    const input = makePermissionInput();
    const result = await processHookEventInput(input, '%unknown-pane');
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.decision).toBe('allow');
    // Should NOT have hookSpecificOutput — unknown panes don't get auto-allowed
    expect(data.hookSpecificOutput).toBeUndefined();
  });

  test('returns hookSpecificOutput with allow decision for registered agent', async () => {
    const room = getOrCreateRoom(TEST_ROOM_PATH, TEST_ROOM_NAME);
    addAgent('worker-1', 'worker', room.id, TEST_PANE);

    const input = makePermissionInput();
    const result = await processHookEventInput(input, TEST_PANE);
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.hookSpecificOutput).toBeDefined();
    expect(data.hookSpecificOutput.hookEventName).toBe('PermissionRequest');
    expect(data.hookSpecificOutput.decision.behavior).toBe('allow');
  });

  test('sets bypassPermissions mode in updatedPermissions', async () => {
    const room = getOrCreateRoom(TEST_ROOM_PATH, TEST_ROOM_NAME);
    addAgent('worker-1', 'worker', room.id, TEST_PANE);

    const input = makePermissionInput();
    const result = await processHookEventInput(input, TEST_PANE);
    const data = parseResult(result);

    const perms = data.hookSpecificOutput.decision.updatedPermissions;
    const setMode = perms.find((p: { type: string }) => p.type === 'setMode');
    expect(setMode).toBeDefined();
    expect(setMode.mode).toBe('bypassPermissions');
    expect(setMode.destination).toBe('session');
  });

  test('echoes permission_suggestions as updatedPermissions', async () => {
    const room = getOrCreateRoom(TEST_ROOM_PATH, TEST_ROOM_NAME);
    addAgent('worker-1', 'worker', room.id, TEST_PANE);

    const suggestions = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'ls' }],
        behavior: 'allow',
        destination: 'session',
      },
    ];

    const input = makePermissionInput({ permission_suggestions: suggestions });
    const result = await processHookEventInput(input, TEST_PANE);
    const data = parseResult(result);

    const perms = data.hookSpecificOutput.decision.updatedPermissions;
    // Should have: setMode + the echoed suggestion
    const echoed = perms.find(
      (p: { type: string }) => p.type === 'addRules',
    );
    expect(echoed).toBeDefined();
    expect(echoed.rules).toEqual([{ toolName: 'Bash', ruleContent: 'ls' }]);
    expect(echoed.behavior).toBe('allow');
  });

  test('works without permission_suggestions', async () => {
    const room = getOrCreateRoom(TEST_ROOM_PATH, TEST_ROOM_NAME);
    addAgent('leader-1', 'leader', room.id, TEST_PANE);

    const input = makePermissionInput();
    const result = await processHookEventInput(input, TEST_PANE);
    const data = parseResult(result);

    expect(data.hookSpecificOutput.decision.updatedPermissions).toHaveLength(1);
    expect(data.hookSpecificOutput.decision.updatedPermissions[0].type).toBe(
      'setMode',
    );
  });

  test('returns basic allow for malformed JSON', async () => {
    const result = await processHookEventInput('not-json', TEST_PANE);
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.decision).toBe('allow');
    expect(data.hookSpecificOutput).toBeUndefined();
  });

  test('returns basic allow when pane is undefined', async () => {
    const input = makePermissionInput();
    const result = await processHookEventInput(input, undefined);
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.hookSpecificOutput).toBeUndefined();
  });

  test('resolves agent from session+cwd fallback when hook has no pane', async () => {
    const room = getOrCreateRoom('/test/permission-room-codex', 'permission-room-codex');
    addAgent('codex-1', 'worker', room.id, '%990', 'codex');

    const input = makePermissionInput({
      session_id: 'codex-session-1',
      cwd: '/test/permission-room-codex/jobs',
    });
    const result = await processHookEventInput(input, undefined);
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.hookSpecificOutput).toBeDefined();
    expect(data.hookSpecificOutput.hookEventName).toBe('PermissionRequest');
    expect(data.hookSpecificOutput.decision.behavior).toBe('allow');

    const latest = getLatestHookEvent('codex-1', 'PermissionRequest', 'codex-session-1');
    expect(latest).not.toBeNull();
    expect(latest?.event_type).toBe('PermissionRequest');
    expect(latest?.session_id).toBe('codex-session-1');
  });
});

describe('PermissionRequest CLI output', () => {
  test('CLI outputs hookSpecificOutput as raw JSON', async () => {
    const room = getOrCreateRoom(TEST_ROOM_PATH, TEST_ROOM_NAME);
    addAgent('worker-1', 'worker', room.id, TEST_PANE);

    const input = makePermissionInput();
    const crewDir = path.resolve(new URL('..', import.meta.url).pathname);
    const proc = Bun.spawn(['bun', 'src/cli.ts', 'hook-event'], {
      cwd: crewDir,
      stdin: new Response(input),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        TMUX_PANE: TEST_PANE,
      },
    });

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const output = JSON.parse(stdout.trim());
    expect(output.hookSpecificOutput).toBeDefined();
    expect(output.hookSpecificOutput.hookEventName).toBe('PermissionRequest');
    expect(output.hookSpecificOutput.decision.behavior).toBe('allow');
  });
});
