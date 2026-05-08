import { initDb } from '../state/db.ts';
import { addHookEvent, getAgentByPane } from '../state/index.ts';
import type { ToolResult } from '../shared/types.ts';

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

  return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
}
