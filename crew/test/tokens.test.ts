import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { extractRecentClaudeTurns } from '../src/observation/claude-transcript.ts';
import { parseJsonlUsage, sumUsageEntries } from '../src/tokens/claude-code.ts';
import { readCodexThreads } from '../src/tokens/codex.ts';
import {
  startTokenCollection,
  stopTokenCollection,
} from '../src/tokens/collector.ts';
import {
  getClaudePidFromPane,
  getSessionForPid,
  resolveSessionPath,
} from '../src/tokens/pid-mapper.ts';
import {
  cleanupAllTestSessions,
  createTestSession,
  destroyTestSession,
} from './helpers.ts';

let restoreTmuxSocket: (() => void) | null = null;

beforeAll(() => {
  const previous = process.env.CREW_TMUX_SOCKET;
  restoreTmuxSocket = () => {
    if (previous === undefined) {
      delete process.env.CREW_TMUX_SOCKET;
    } else {
      process.env.CREW_TMUX_SOCKET = previous;
    }
  };
});

afterAll(async () => {
  await cleanupAllTestSessions();
  restoreTmuxSocket?.();
});

describe('pid-mapper', () => {
  test('getClaudePidFromPane returns null for nonexistent pane', async () => {
    const pid = await getClaudePidFromPane('%99999');
    expect(pid).toBeNull();
  });

  test('getSessionForPid returns null for bogus PID', () => {
    const session = getSessionForPid(999999999);
    expect(session).toBeNull();
  });

  test('resolveSessionPath builds correct JSONL path', () => {
    const path = resolveSessionPath(
      'abc-123',
      '/Users/lee/code/utils/agent-crew',
    );
    expect(path).toContain('.claude/projects/');
    expect(path).toContain('abc-123');
    expect(path).toEndWith('.jsonl');
  });

  test('getClaudePidFromPane does not require the user live pane', async () => {
    const session = await createTestSession('pid-mapper-shell');
    try {
      expect(process.env.CREW_TMUX_SOCKET).toMatch(/^crew-test-/);
      const pid = await getClaudePidFromPane(session.pane);
      expect(pid).toBeNull();
    } finally {
      await destroyTestSession('pid-mapper-shell');
    }
  });

  test('getSessionForPid returns session info for existing session file', () => {
    const fs = require('node:fs');
    const sessDir = `${process.env.HOME}/.claude/sessions`;
    if (!fs.existsSync(sessDir)) return;
    const files = fs
      .readdirSync(sessDir)
      .filter((f: string) => f.endsWith('.json'));
    if (files.length === 0) return;
    const pid = parseInt(files[0].replace('.json', ''), 10);
    const session = getSessionForPid(pid);
    if (session) {
      expect(session.sessionId).toBeDefined();
      expect(typeof session.sessionId).toBe('string');
    }
  });
});

describe('claude-code token collection', () => {
  test('parseJsonlUsage extracts usage from JSONL lines', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 300,
          },
          stop_reason: 'end_turn',
        },
      }),
      JSON.stringify({ type: 'human', text: 'hello' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6',
          usage: { input_tokens: 150, output_tokens: 75 },
          stop_reason: 'end_turn',
        },
      }),
    ];
    const entries = parseJsonlUsage(lines.join('\n'));
    expect(entries.length).toBe(2);
    expect(entries[0]?.input_tokens).toBe(100);
    expect(entries[0]?.output_tokens).toBe(50);
    expect(entries[0]?.model).toBe('claude-opus-4-6');
  });

  test('sumUsageEntries totals tokens correctly', () => {
    const entries = [
      {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 0,
        model: 'claude-opus-4-6',
      },
      {
        input_tokens: 150,
        output_tokens: 75,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100,
        model: 'claude-opus-4-6',
      },
    ];
    const totals = sumUsageEntries(entries);
    expect(totals.input_tokens).toBe(250);
    expect(totals.output_tokens).toBe(125);
    expect(totals.model).toBe('claude-opus-4-6');
  });

  test('parseJsonlUsage handles empty input', () => {
    expect(parseJsonlUsage('')).toEqual([]);
  });
});

describe('claude transcript inspection parsing', () => {
  test('extracts recent user and assistant turns from JSONL transcript', () => {
    const transcript = [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-06-03T10:00:00.000Z',
        message: {
          role: 'user',
          content: 'Run auth tests',
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-03T10:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Running auth tests now.' }],
        },
      }),
    ].join('\n');

    const turns = extractRecentClaudeTurns(transcript, 2);

    expect(turns).toEqual([
      {
        role: 'user',
        text: 'Run auth tests',
        timestamp: '2026-06-03T10:00:00.000Z',
      },
      {
        role: 'assistant',
        text: 'Running auth tests now.',
        timestamp: '2026-06-03T10:00:02.000Z',
      },
    ]);
  });

  test('filters metadata-only records and keeps the latest N turns', () => {
    const transcript = [
      JSON.stringify({ type: 'system', timestamp: '2026-06-03T10:00:00.000Z' }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-06-03T10:00:01.000Z',
        message: { role: 'user', content: 'first' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-03T10:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'bash' },
            { type: 'text', text: 'second' },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-03T10:00:03.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '   ' }],
        },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-06-03T10:00:04.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'third' }] },
      }),
    ].join('\n');

    const turns = extractRecentClaudeTurns(transcript, 2);

    expect(turns).toEqual([
      {
        role: 'assistant',
        text: 'second',
        timestamp: '2026-06-03T10:00:02.000Z',
      },
      {
        role: 'user',
        text: 'third',
        timestamp: '2026-06-03T10:00:04.000Z',
      },
    ]);
  });
});

describe('codex token collection', () => {
  test('readCodexThreads returns array (may be empty if no codex db)', () => {
    const threads = readCodexThreads();
    expect(Array.isArray(threads)).toBe(true);
  });

  test('readCodexThreads entries have expected shape', () => {
    const threads = readCodexThreads();
    if (threads.length === 0) return;
    const first = threads[0];
    expect(first).toHaveProperty('tokens_used');
    expect(first).toHaveProperty('model');
    expect(typeof first.tokens_used).toBe('number');
  });
});

describe('agent type detection', () => {
  test('inferAgentTypeFromProcesses prefers descendant Claude over wrapper commands', async () => {
    const { inferAgentTypeFromProcesses } = await import('../src/tools/join-room.ts');
    const result = inferAgentTypeFromProcesses([
      {
        comm: 'node',
        args: '/home/vtit/.nvm/versions/node/v24.15.0/bin/ccs codex',
      },
      {
        comm: 'claude',
        args: '/home/vtit/.local/bin/claude --settings /home/vtit/.ccs/glm.settings.json',
      },
    ]);
    expect(result).toBe('claude-code');
  });

  test('inferAgentTypeFromProcesses detects codex when no Claude process exists', async () => {
    const { inferAgentTypeFromProcesses } = await import('../src/tools/join-room.ts');
    const result = inferAgentTypeFromProcesses([
      {
        comm: 'node',
        args: '/home/vtit/.nvm/versions/node/v24.15.0/bin/codex',
      },
      {
        comm: 'codex',
        args: '/home/vtit/.nvm/versions/node/v24.15.0/lib/node_modules/@openai/codex/bin/codex',
      },
    ]);
    expect(result).toBe('codex');
  });

  test('detectAgentType uses an isolated pane instead of TMUX_PANE', async () => {
    const { detectAgentType } = await import('../src/tools/join-room.ts');
    const session = await createTestSession('detect-agent-type-shell');
    try {
      expect(process.env.CREW_TMUX_SOCKET).toMatch(/^crew-test-/);
      const result = await detectAgentType(session.pane);
      expect(result).toBe('unknown');
    } finally {
      await destroyTestSession('detect-agent-type-shell');
    }
  });

  test('detectAgentType returns unknown for bogus pane', async () => {
    const { detectAgentType } = await import('../src/tools/join-room.ts');
    const result = await detectAgentType('%99999');
    expect(result).toBe('unknown');
  });
});

describe('token collection lifecycle', () => {
  test('startTokenCollection and stopTokenCollection do not throw', () => {
    startTokenCollection();
    stopTokenCollection();
  });

  test('double start is safe', () => {
    startTokenCollection();
    startTokenCollection(); // should not throw or double-start
    stopTokenCollection();
  });
});
