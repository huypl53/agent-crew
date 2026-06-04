import type { ToolResult } from '../shared/types.ts';
import { getDb, initDb } from '../state/db.ts';
import {
  addHookEvent,
  canonicalizeHintIdentity,
  clearArmedInputBlock,
  getAgentByPane,
  tickHintCadence,
} from '../state/index.ts';

function okResult(payload: Record<string, unknown> = { ok: true }): ToolResult {
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

  const eventType = String(payload.hook_event_name ?? 'Unknown');
  const sessionId =
    typeof payload.session_id === 'string' ? payload.session_id : null;

  addHookEvent(agent.name, eventType, sessionId, input);

  // Canonicalize hint identity when session_id is first available
  if (sessionId) {
    try {
      canonicalizeHintIdentity(agent.name, pane, sessionId);
    } catch (e) {
      // Fail-open: don't block hook processing on canonicalization errors
      console.error(`[crew hint] canonicalize error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Hint injection: on every Nth UserPromptSubmit (where N = cadence),
  // emit the user-defined message to stdout. Claude Code injects hook
  // stdout into the conversation, providing custom context reminders.
  if (eventType === 'UserPromptSubmit') {
    clearArmedInputBlock(agent.name);
    try {
      const { shouldShow, hint } = tickHintCadence(pane, sessionId, agent.room_id);
      if (shouldShow && hint) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                hint: { agent_name: hint.agent_name, message: hint.message },
              }),
            },
          ],
        };
      }
    } catch (e) {
      // Fail-open: never block hook processing on hint errors
      console.error(`[crew hint] cadence error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return okResult();
}

export async function handleHookEvent(_params?: unknown): Promise<ToolResult> {
  const input = await Bun.stdin.text();
  return processHookEventInput(input, process.env.TMUX_PANE);
}
