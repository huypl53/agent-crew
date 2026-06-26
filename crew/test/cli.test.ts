import { describe, expect, test } from 'bun:test';
import { formatResult } from '../src/cli/formatter.ts';
import { parseArgs } from '../src/cli/parse.ts';

describe('CLI arg parser', () => {
  test('parses subcommand and positional args', () => {
    const result = parseArgs([
      'send',
      '--room',
      'crew',
      '--to',
      'wk-01',
      '--text',
      'hello',
    ]);
    expect(result.command).toBe('send');
    expect(result.flags.room).toBe('crew');
    expect(result.flags.to).toBe('wk-01');
    expect(result.flags.text).toBe('hello');
  });

  test('parses boolean flags', () => {
    const result = parseArgs(['status', 'wk-01', '--json']);
    expect(result.command).toBe('status');
    expect(result.positional).toEqual(['wk-01']);
    expect(result.flags.json).toBe(true);
  });

  test('returns help for no args', () => {
    const result = parseArgs([]);
    expect(result.command).toBe('help');
  });

  test('parses array flags (kinds)', () => {
    const result = parseArgs([
      'read',
      '--name',
      'lead-01',
      '--kinds',
      'task,completion',
    ]);
    expect(result.flags.kinds).toBe('task,completion');
  });

  test('parses short flags and short boolean flags', () => {
    const result = parseArgs(['block', '-n', 'wk-01', '-p']);
    expect(result.command).toBe('block');
    expect(result.flags.name).toBe('wk-01');
    expect(result.flags.persist).toBe(true);
  });
});

describe('CLI formatter', () => {
  test('formats status output', () => {
    const data = {
      name: 'wk-01',
      status: 'idle',
      tmux_target: '%33',
      rooms: ['crew'],
    };
    const out = formatResult('status', data);
    expect(out).toContain('wk-01');
    expect(out).toContain('idle');
    expect(out).toContain('%33');
  });

  test('formats check output as key:value pairs', () => {
    const data = { scopes: { messages: 42, agents: 8 } };
    const out = formatResult('check', data);
    expect(out).toBe('messages:42 agents:8');
  });

  test('formats rooms list', () => {
    const data = {
      rooms: [
        {
          name: 'crew',
          member_count: 5,
          roles: { leader: 1, worker: 3 },
        },
      ],
    };
    const out = formatResult('rooms', data);
    expect(out).toContain('crew');
    expect(out).toContain('5 members');
  });

  test('formats messages one per line', () => {
    const data = {
      messages: [
        {
          from: 'leader',
          room: 'crew',
          text: 'hello',
          timestamp: '2026-04-12T10:00:00Z',
        },
        {
          from: 'wk-01',
          room: 'crew',
          text: 'done',
          timestamp: '2026-04-12T10:01:00Z',
        },
      ],
      next_sequence: 100,
    };
    const out = formatResult('read', data);
    const lines = out.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('[leader@crew]');
    expect(lines[0]).toContain('hello');
  });

  test('formats send result', () => {
    const data = { message_id: '42', delivered: true, queued: true };
    const out = formatResult('send', data);
    expect(out).toContain('42');
    expect(out).toContain('delivered');
  });

  test('formats send result with members status when present', () => {
    const data = {
      message_id: '42',
      delivered: true,
      queued: true,
      members: [
        {
          name: 'wk-01',
          role: 'worker',
          status: 'idle',
          input_block_mode: 'persist',
        },
        {
          name: 'lead',
          role: 'leader',
          status: 'idle',
          input_block_mode: 'off',
        },
      ],
    };
    const out = formatResult('send', data);
    expect(out).toContain('msg:42 delivered');
    expect(out).toContain('Members:');
    expect(out).toContain(
      '  wk-01 worker idle pane:(none) input-block:persist',
    );
    expect(out).toContain('  lead leader idle pane:(none) input-block:off');
  });

  test('formats members list', () => {
    const data = {
      room: 'crew',
      topic: 'building stuff',
      members: [
        {
          name: 'wk-01',
          role: 'worker',
          status: 'idle',
          input_block_mode: 'persist',
        },
      ],
    };
    const out = formatResult('members', data);
    expect(out).toContain('wk-01');
    expect(out).toContain('worker');
    expect(out).toContain('idle');
    expect(out).toContain('input-block:persist');
  });

  test('formats input-block output', () => {
    const out = formatResult('input-block', {
      name: 'wk-01',
      input_block_mode: 'armed',
    });
    expect(out).toContain('wk-01');
    expect(out).toContain('armed');

    const ibOut = formatResult('ib', {
      name: 'wk-01',
      input_block_mode: 'armed',
    });
    expect(ibOut).toContain('wk-01');
    expect(ibOut).toContain('armed');

    const blockOut = formatResult('block', {
      name: 'wk-01',
      input_block_mode: 'persist',
    });
    expect(blockOut).toContain('wk-01');
    expect(blockOut).toContain('persist');

    const unblockOut = formatResult('unblock', {
      name: 'wk-01',
      input_block_mode: 'off',
    });
    expect(unblockOut).toContain('wk-01');
    expect(unblockOut).toContain('off');
  });

  test('formats inspect output with turns and degradation metadata', () => {
    const data = {
      agent_name: 'worker-1',
      room_name: 'frontend',
      provider: 'claude-code',
      session_id: 'sess-1',
      status: 'busy',
      updated_at: '2026-06-03T10:00:02.000Z',
      block_hint: 'running',
      source: 'transcript',
      degraded: false,
      degradation_reason: 'none',
      turns: [
        {
          role: 'user',
          text: 'Run tests',
          timestamp: '2026-06-03T10:00:00.000Z',
        },
      ],
    };
    const out = formatResult('inspect', data);
    expect(out).toContain('worker: worker-1');
    expect(out).toContain('room: frontend');
    expect(out).toContain('[user] Run tests');
    expect(out).toContain('source: transcript');
    expect(out).not.toContain('degraded: true');
  });

  test('formats degraded inspect output explicitly', () => {
    const data = {
      agent_name: 'worker-1',
      room_name: 'frontend',
      provider: 'claude-code',
      session_id: null,
      status: 'busy',
      updated_at: '2026-06-03T10:00:02.000Z',
      block_hint: 'unknown',
      source: 'hook-events',
      degraded: true,
      degradation_reason: 'session_unresolved',
      turns: [
        {
          role: 'assistant',
          text: 'Waiting for permission.',
          timestamp: '2026-06-03T10:00:02.000Z',
        },
      ],
    };
    const out = formatResult('inspect', data);
    expect(out).toContain('degraded: true');
    expect(out).toContain('degradation_reason: session_unresolved');
    expect(out).toContain('[assistant] Waiting for permission.');
  });

  test('formats mute and unmute outputs', () => {
    const data = {
      name: 'lead-01',
      idle_muted: true,
      note: 'notifications muted',
    };
    const muteOut = formatResult('mute', data);
    expect(muteOut).toContain('lead-01');
    expect(muteOut).toContain('muted');
    expect(muteOut).toContain('notifications muted');

    const unmuteOut = formatResult('unmute', {
      ...data,
      idle_muted: false,
      note: 'notifications unmuted',
    });
    expect(unmuteOut).toContain('lead-01');
    expect(unmuteOut).toContain('unmuted');
    expect(unmuteOut).toContain('notifications unmuted');
  });

  test('formats goal update output with confirmed goal details', () => {
    const out = formatResult('goal', {
      ok: true,
      goal: {
        agent_name: 'wk-01',
        description: 'Fix bug in auth.ts',
        status: 'active',
        turn_count: 3,
      },
      message: 'Goal updated for wk-01 in crew',
    });

    expect(out).toBe('🎯 wk-01: "Fix bug in auth.ts" (active, turn 3)');
    expect(out).not.toContain('undefined');
  });

  test('formats polling status outputs', () => {
    const data = {
      paused: true,
      busy_mode: 'manual_busy',
      reason: 'test pause',
    };
    const out = formatResult('polling', data);
    expect(out).toContain('paused=true');
    expect(out).toContain('mode=manual_busy');
    expect(out).toContain('reason:test pause');
  });

  test('formats send result with members status, context window and recommendation', () => {
    const data = {
      message_id: '42',
      delivered: true,
      queued: true,
      members: [
        {
          name: 'wk-01',
          role: 'worker',
          status: 'idle',
          input_block_mode: 'persist',
          ctx_pct: 85.5,
        },
        {
          name: 'lead',
          role: 'leader',
          status: 'idle',
          input_block_mode: 'off',
          ctx_pct: 42.0,
        },
      ],
    };
    const out = formatResult('send', data);
    expect(out).toContain('msg:42 delivered');
    expect(out).toContain('Members:');
    expect(out).toContain(
      '  wk-01 worker idle pane:(none) input-block:persist context-window:85.5% ⚠ compact/clear encouraged',
    );
    expect(out).toContain(
      '  lead leader idle pane:(none) input-block:off context-window:42%',
    );
  });

  test('formats send-batch result with context window and recommendation', () => {
    const data = {
      batch_id: 'batch_123',
      workers: [
        { name: 'wk-01', dispatch_status: 'sent', ctx_pct: 80 },
        { name: 'wk-02', dispatch_status: 'sent', ctx_pct: 12 },
      ],
    };
    const out = formatResult('send-batch', data);
    expect(out).toContain('batch:batch_123');
    expect(out).toContain(
      '  wk-01: sent context-window:80% ⚠ compact/clear encouraged',
    );
    expect(out).toContain('  wk-02: sent context-window:12%');
  });

  test('formats goal overview with context window and recommendation', () => {
    const data = {
      overview: true,
      room: 'crew',
      goals: [
        {
          agent_name: 'wk-01',
          description: 'Do task',
          status: 'active',
          turn_count: 5,
          ctx_pct: 90.1,
        },
      ],
    };
    const out = formatResult('goal', data);
    expect(out).toContain('Goals in room "crew":');
    expect(out).toContain(
      '🎯 wk-01: "Do task" (active, turn 5) context-window:90.1% ⚠ compact/clear encouraged',
    );
  });

  test('formats goal done/unset with context window and recommendation', () => {
    const doneData = {
      goal_status: 'done',
      message: 'Goal completed for wk-01',
      ctx_pct: 82.3,
    };
    const doneOut = formatResult('goal', doneData);
    expect(doneOut).toContain(
      'Goal done — Goal completed for wk-01 context-window:82.3% ⚠ compact/clear encouraged',
    );

    const unsetData = {
      removed: true,
      message: 'Goal removed for wk-01',
      ctx_pct: 85.0,
    };
    const unsetOut = formatResult('goal', unsetData);
    expect(unsetOut).toContain(
      'Goal removed for wk-01 context-window:85% ⚠ compact/clear encouraged',
    );
  });
});
