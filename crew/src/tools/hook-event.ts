import { readFileSync } from 'node:fs';
import { spawnSync } from 'bun';
import type { ToolResult } from '../shared/types.ts';
import { getDb, initDb } from '../state/db.ts';
import {
  addHookEvent,
  canonicalizeHintIdentity,
  clearArmedInputBlock,
  getAgentByPane,
  tickHintCadence,
} from '../state/index.ts';

function okResult(
  payload: Record<string, unknown> = { ok: true, decision: 'allow' },
): ToolResult {
  if (payload.decision === undefined) {
    payload.decision = 'allow';
  }
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

export async function processHookEventInput(
  input: string,
  pane: string | undefined,
): Promise<ToolResult> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(input);
  } catch {
    // Malformed JSON — silently exit
    return okResult();
  }

  if (!pane) {
    return okResult();
  }

  try {
    getDb();
  } catch {
    initDb();
  }

  const agent = getAgentByPane(pane);
  if (!agent) {
    return okResult();
  }

  const eventType = String(
    payload.hook_event_name ?? payload.event ?? payload.eventName ?? 'Unknown',
  );
  const sessionId =
    typeof payload.session_id === 'string'
      ? payload.session_id
      : typeof payload.sessionId === 'string'
        ? payload.sessionId
        : null;

  addHookEvent(agent.name, eventType, sessionId, input);

  // Canonicalize hint identity when session_id is first available
  if (sessionId) {
    try {
      canonicalizeHintIdentity(agent.name, pane, sessionId);
    } catch (e) {
      // Fail-open: don't block hook processing on canonicalization errors
      console.error(
        `[crew hint] canonicalize error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Hint injection: on every Nth UserPromptSubmit (where N = cadence),
  // emit the user-defined message to stdout. Claude Code injects hook
  // stdout into the conversation, providing custom context reminders.
  if (eventType === 'UserPromptSubmit') {
    clearArmedInputBlock(agent.name);
    try {
      const { shouldShow, hint } = tickHintCadence(
        pane,
        sessionId,
        agent.room_id,
      );
      if (shouldShow && hint) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                decision: 'allow',
                hint: { agent_name: hint.agent_name, message: hint.message },
              }),
            },
          ],
        };
      }
    } catch (e) {
      // Fail-open: never block hook processing on hint errors
      console.error(
        `[crew hint] cadence error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return okResult();
}

function getParentPid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const parts = stat.split(' ');
    return parseInt(parts[3], 10);
  } catch {
    return null;
  }
}

function getAncestry(pid: number): number[] {
  const list: number[] = [];
  let current: number | null = pid;
  while (current && current > 1) {
    list.push(current);
    current = getParentPid(current);
  }
  return list;
}

function getTmuxPanes(): Map<number, string> {
  const map = new Map<number, string>();
  try {
    const socket = process.env.CREW_TMUX_SOCKET;
    const args = socket ? ['-L', socket] : [];
    const res = spawnSync([
      'tmux',
      ...args,
      'list-panes',
      '-a',
      '-F',
      '#{pane_pid} #{pane_id}',
    ]);
    if (res.success) {
      const output = res.stdout.toString().trim();
      for (const line of output.split('\n')) {
        const [pidStr, paneId] = line.trim().split(/\s+/);
        if (pidStr && paneId) {
          const pid = parseInt(pidStr, 10);
          if (Number.isInteger(pid)) {
            map.set(pid, paneId);
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return map;
}

export function resolvePaneId(): string | undefined {
  if (process.env.TMUX_PANE) {
    return process.env.TMUX_PANE;
  }
  const panes = getTmuxPanes();
  if (panes.size === 0) return undefined;

  const ancestry = getAncestry(process.pid);
  for (const pid of ancestry) {
    const paneId = panes.get(pid);
    if (paneId) {
      return paneId;
    }
  }
  return undefined;
}

export async function handleHookEvent(_params?: unknown): Promise<ToolResult> {
  const input = await Bun.stdin.text();
  return processHookEventInput(input, resolvePaneId());
}
