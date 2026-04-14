import { ok, err } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { getDb } from '../state/db.ts';

interface HeartbeatParams {
  pane?: string;
  name?: string;
}

/**
 * Update an agent's last_heartbeat timestamp.
 * Called periodically by agents to signal they are alive.
 * Pane is resolved from: param > TMUX_PANE env var.
 */
export async function handleHeartbeat(params: HeartbeatParams): Promise<ToolResult> {
  const targetPane = params.pane || process.env.TMUX_PANE;

  if (!targetPane && !params.name) {
    return err('Missing required param: pane or name (set TMUX_PANE env var or provide --pane / --name)');
  }

  const db = getDb();
  const now = Date.now();

  let changes: number;

  if (params.name) {
    // Update by agent name
    const result = db.run(
      'UPDATE agents SET last_heartbeat = ? WHERE name = ?',
      [now, params.name],
    );
    changes = result.changes;
  } else {
    // Update by pane
    const result = db.run(
      'UPDATE agents SET last_heartbeat = ? WHERE pane = ?',
      [now, targetPane],
    );
    changes = result.changes;
  }

  if (changes === 0) {
    const identifier = params.name ? `name=${params.name}` : `pane=${targetPane}`;
    return err(`No agent found for ${identifier}`);
  }

  return ok({
    pane: targetPane ?? null,
    name: params.name ?? null,
    last_heartbeat: new Date(now).toISOString(),
    status: 'alive',
  });
}
