import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.HOME ?? '';
const CLAUDE_SESSIONS_DIR = join(HOME, '.claude', 'sessions');

// AGY (Antigravity) transcript paths
const AGY_BRAIN_DIR_CLI = join(HOME, '.gemini', 'antigravity-cli', 'brain');
const AGY_BRAIN_DIR_DESKTOP = join(HOME, '.gemini', 'antigravity', 'brain');
const AGY_TRANSCRIPT_SUFFIX = join('.system_generated', 'logs', 'transcript.jsonl');

interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind: string;
  name?: string;
}

function getTmuxSocketArgs(): string[] {
  const socket = process.env.CREW_TMUX_SOCKET;
  return socket ? ['-L', socket] : [];
}

export async function getClaudePidFromPane(
  paneTarget: string,
): Promise<number | null> {
  try {
    const shellProc = Bun.spawn(
      [
        'tmux',
        ...getTmuxSocketArgs(),
        'display-message',
        '-p',
        '-t',
        paneTarget,
        '#{pane_pid}',
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const shellPidStr = (await new Response(shellProc.stdout).text()).trim();
    await shellProc.exited;
    const shellPid = Number.parseInt(shellPidStr, 10);
    if (Number.isNaN(shellPid)) return null;

    // BFS to find all descendant PIDs
    const pending = [shellPid];
    const descendants: number[] = [];
    const seen = new Set<number>();

    while (pending.length > 0) {
      const parentPid = pending.shift();
      if (parentPid == null || seen.has(parentPid)) continue;
      seen.add(parentPid);

      const pgrepProc = Bun.spawn(['pgrep', '-P', String(parentPid)], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const childPidOutput = (await new Response(pgrepProc.stdout).text())
        .trim()
        .split('\n');
      await pgrepProc.exited;

      for (const cpid of childPidOutput) {
        if (!cpid.trim()) continue;
        const childPid = Number.parseInt(cpid.trim(), 10);
        if (Number.isNaN(childPid) || seen.has(childPid)) continue;
        pending.push(childPid);
        descendants.push(childPid);
      }
    }

    if (descendants.length === 0) return null;

    for (const pid of descendants) {
      const sessionFile = join(CLAUDE_SESSIONS_DIR, `${pid}.json`);
      if (existsSync(sessionFile)) return pid;
    }
    return descendants[0] ?? null;
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
  const projectHash = cwd.replace(/[^a-zA-Z0-9]/g, '-');
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
  return {
    claudePid,
    sessionId: session.sessionId,
    sessionPath,
    name: session.name,
  };
}

/**
 * Resolve the transcript path for an AGY (Antigravity) conversation.
 * AGY uses conversationId (UUID) directly — no PID mapping needed.
 * Checks CLI path first, then Desktop path.
 */
export function resolveAgyTranscriptPath(conversationId: string): string | null {
  const cliPath = join(AGY_BRAIN_DIR_CLI, conversationId, AGY_TRANSCRIPT_SUFFIX);
  if (existsSync(cliPath)) return cliPath;

  const desktopPath = join(AGY_BRAIN_DIR_DESKTOP, conversationId, AGY_TRANSCRIPT_SUFFIX);
  if (existsSync(desktopPath)) return desktopPath;

  return null;
}

