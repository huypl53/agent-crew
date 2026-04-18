import { ok, err } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { getRoomByPath, refreshAgent } from '../state/index.ts';
import { paneExists, getPaneCwd } from '../tmux/index.ts';
import { normalizePath } from '../shared/path-utils.ts';

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

  const cwd = await getPaneCwd(target);
  if (!cwd) {
    return err(`Could not determine CWD for pane ${target}`);
  }

  const normalizedPath = normalizePath(cwd);
  const room = getRoomByPath(normalizedPath);

  if (!room) {
    return err(`Room not found for path: ${normalizedPath}. Use 'crew join' to register first.`);
  }

  const agent = await refreshAgent(room.id, name, target);
  if (!agent) {
    return err(`Agent "${name}" not found in room "${room.name}". Use 'crew join' to register first.`);
  }

  return ok({
    agent_id: agent.agent_id,
    name: agent.name,
    role: agent.role,
    room: agent.room_name,
    room_path: agent.room_path,
    tmux_target: agent.tmux_target,
  });
}
