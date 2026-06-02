import type { ToolResult } from '../shared/types.ts';
import { initDb } from '../state/db.ts';
import {
  addHookEvent,
  canonicalizeHintIdentity,
  getAgentByPane,
  tickHintCadence,
} from '../state/index.ts';

export async function handleHookEvent(_params?: unknown): Promise<ToolResult> {
  const input = await Bun.stdin.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(input);
  } catch {
    // Malformed JSON — silently exit
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  }

  const pane = process.env.TMUX_PANE;
  if (!pane) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  }

  initDb();

  const agent = getAgentByPane(pane);
  if (!agent) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
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

  return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
}
