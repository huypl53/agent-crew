import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDb } from '../src/state/db.ts';
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

  test('getClaudePidFromPane returns a number for a live claude pane', async () => {
    const ownPane = process.env.TMUX_PANE;
    if (!ownPane) return;
    const pid = await getClaudePidFromPane(ownPane);
    if (pid !== null) {
      expect(pid).toBeGreaterThan(0);
    }
  });

  test('getSessionForPid returns session info for existing session file', () => {
    const fs = require('fs');
    const sessDir = `${process.env.HOME}/.claude/sessions`;
    if (!fs.existsSync(sessDir)) return;
    const files = fs
      .readdirSync(sessDir)
      .filter((f: string) => f.endsWith('.json'));
    if (files.length === 0) return;
    const pid = parseInt(files[0].replace('.json', ''));
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
    expect(entries[0]!.input_tokens).toBe(100);
    expect(entries[0]!.output_tokens).toBe(50);
    expect(entries[0]!.model).toBe('claude-opus-4-6');
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
  test('detectAgentType returns a valid type', async () => {
    const { detectAgentType } = await import('../src/tools/join-room.ts');
    const pane = process.env.TMUX_PANE;
    if (!pane) return; // skip outside tmux
    const result = await detectAgentType(pane);
    expect(['claude-code', 'codex', 'unknown']).toContain(result);
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
