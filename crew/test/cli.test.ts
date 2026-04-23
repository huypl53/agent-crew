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
    const data = { scopes: { messages: 42, tasks: 15, agents: 8 } };
    const out = formatResult('check', data);
    expect(out).toBe('messages:42 tasks:15 agents:8');
  });

  test('formats rooms list', () => {
    const data = {
      rooms: [
        {
          name: 'crew',
          member_count: 5,
          roles: { boss: 1, leader: 1, worker: 3 },
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
          from: 'boss',
          room: 'crew',
          text: 'hello',
          kind: 'chat',
          timestamp: '2026-04-12T10:00:00Z',
        },
        {
          from: 'wk-01',
          room: 'crew',
          text: 'done',
          kind: 'completion',
          timestamp: '2026-04-12T10:01:00Z',
        },
      ],
      next_sequence: 100,
    };
    const out = formatResult('read', data);
    const lines = out.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('[boss@crew]');
    expect(lines[0]).toContain('hello');
  });

  test('formats send result', () => {
    const data = { message_id: '42', delivered: true, queued: true };
    const out = formatResult('send', data);
    expect(out).toContain('42');
    expect(out).toContain('delivered');
  });

  test('formats members list', () => {
    const data = {
      room: 'crew',
      topic: 'building stuff',
      members: [{ name: 'wk-01', role: 'worker', status: 'idle' }],
    };
    const out = formatResult('members', data);
    expect(out).toContain('wk-01');
    expect(out).toContain('worker');
    expect(out).toContain('idle');
  });
});
