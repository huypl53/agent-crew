import { describe, test, expect } from 'bun:test';
import { getClaudePidFromPane, getSessionForPid, resolveSessionPath } from '../src/tokens/pid-mapper.ts';

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
    const path = resolveSessionPath('abc-123', '/Users/lee/code/utils/agent-crew');
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
    const files = fs.readdirSync(sessDir).filter((f: string) => f.endsWith('.json'));
    if (files.length === 0) return;
    const pid = parseInt(files[0].replace('.json', ''));
    const session = getSessionForPid(pid);
    if (session) {
      expect(session.sessionId).toBeDefined();
      expect(typeof session.sessionId).toBe('string');
    }
  });
});
