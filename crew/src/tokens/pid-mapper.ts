import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const HOME = process.env.HOME ?? '';
const CLAUDE_SESSIONS_DIR = join(HOME, '.claude', 'sessions');

interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind: string;
  name?: string;
}

export async function getClaudePidFromPane(paneTarget: string): Promise<number | null> {
  try {
    const shellProc = Bun.spawn(['tmux', 'display-message', '-p', '-t', paneTarget, '#{pane_pid}'], {
      stdout: 'pipe', stderr: 'pipe',
    });
    const shellPidStr = (await new Response(shellProc.stdout).text()).trim();
    await shellProc.exited;
    const shellPid = parseInt(shellPidStr);
    if (isNaN(shellPid)) return null;

    const pgrepProc = Bun.spawn(['pgrep', '-P', String(shellPid)], {
      stdout: 'pipe', stderr: 'pipe',
    });
    const childPidsStr = (await new Response(pgrepProc.stdout).text()).trim();
    await pgrepProc.exited;
    if (!childPidsStr) return null;

    const childPids = childPidsStr.split('\n').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    for (const pid of childPids) {
      const sessionFile = join(CLAUDE_SESSIONS_DIR, `${pid}.json`);
      if (existsSync(sessionFile)) return pid;
    }
    return childPids[0] ?? null;
  } catch {
    return null;
  }
}

export function getSessionForPid(pid: number): ClaudeSession | null {
  try {
    const sessionFile = join(CLAUDE_SESSIONS_DIR, `${pid}.json`);
    if (!existsSync(sessionFile)) return null;
    return JSON.parse(readFileSync(sessionFile, 'utf-8'));
  } catch {
    return null;
  }
}

export function resolveSessionPath(sessionId: string, cwd: string): string {
  const projectHash = cwd.replace(/\//g, '-');
  return join(HOME, '.claude', 'projects', projectHash, `${sessionId}.jsonl`);
}

export async function resolveAgentSession(paneTarget: string): Promise<{
  claudePid: number;
  sessionId: string;
  sessionPath: string;
  name?: string;
} | null> {
  const claudePid = await getClaudePidFromPane(paneTarget);
  if (!claudePid) return null;
  const session = getSessionForPid(claudePid);
  if (!session) return null;
  const sessionPath = resolveSessionPath(session.sessionId, session.cwd);
  return { claudePid, sessionId: session.sessionId, sessionPath, name: session.name };
}
