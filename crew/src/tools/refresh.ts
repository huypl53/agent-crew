import { ok, err } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { refreshAgent } from '../state/index.ts';
import { paneExists } from '../tmux/index.ts';

interface RefreshParams {
  name: string;
  tmux_target?: string;
}

export async function handleRefresh(params: RefreshParams): Promise<ToolResult> {
  const { name, tmux_target } = params;

  if (!name) {
    return err('Missing required param: name');
  }

  // Resolve tmux target
  let target = tmux_target;
  if (!target) {
    const pane = process.env.TMUX_PANE;
    if (!pane) {
      return err('Not running inside a tmux pane. Set TMUX_PANE env var, or provide tmux_target param.');
    }
    target = pane;
  }

  // Validate pane exists
  const exists = await paneExists(target);
  if (!exists) {
    return err(`tmux pane ${target} does not exist`);
  }

  const agent = await refreshAgent(name, target);
  if (!agent) {
    return err(`Agent "${name}" not found in database or legacy state`);
  }

  return ok({
    agent_id: agent.agent_id,
    name: agent.name,
    role: agent.role,
    rooms: agent.rooms,
    tmux_target: agent.tmux_target,
    migrated: false,
  });
}
