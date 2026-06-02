import type { ToolResult } from '../shared/types.ts';
import { initDb } from '../state/db.ts';
import {
  addHookEvent,
  canonicalizeHintIdentity,
  getAgentByPane,
  tickHintCadence,
} from '../state/index.ts';

/** Strip control characters and cap length to prevent prompt-injection via agent names. */
function sanitizeAgentName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64);
}

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

  // Hint reminder injection: every 3rd UserPromptSubmit, emit reminder text to
  // stdout. Stdout from hook commands is injected into the conversation by
  // Claude Code, providing gentle agent-identity reminders without polling.
  if (eventType === 'UserPromptSubmit') {
    try {
      const { shouldShow, hint } = tickHintCadence(pane, sessionId, agent.room_id);
      if (shouldShow && hint) {
        const safeName = sanitizeAgentName(hint.agent_name);
        const reminder = `[crew] Registered as agent "${safeName}". Run \`crew hint unset\` from this pane to clear.`;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                hint: { agent_name: safeName, message: reminder },
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
