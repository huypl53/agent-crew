import { normalizePath } from '../shared/path-utils.ts';
import type { ToolResult } from '../shared/types.ts';
import { err, ok, randomSuffix } from '../shared/types.ts';
import {
  getAgentByRoomAndName,
  getRoomByPath,
  refreshAgent,
} from '../state/index.ts';
import { getPaneCwd, paneExists } from '../tmux/index.ts';

interface RefreshParams {
  name: string;
  tmux_target?: string;
}

export async function handleRefresh(
  params: RefreshParams,
): Promise<ToolResult> {
  const { name, tmux_target } = params;

  if (!name) {
    return err('Missing required param: name');
  }

  // Resolve tmux target
  let target = tmux_target;
  if (!target) {
    const pane = process.env.TMUX_PANE;
    if (!pane) {
      return err(
        'Not running inside a tmux pane. Set TMUX_PANE env var, or provide tmux_target param.',
      );
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
    return err(
      `Room not found for path: ${normalizedPath}. Use 'crew join' to register first.`,
    );
  }

  const oldAgent = getAgentByRoomAndName(room.id, name);
  const oldPane = oldAgent?.tmux_target ?? null;

  const agent = await refreshAgent(room.id, name, target);
  if (!agent) {
    return err(
      `Agent "${name}" not found in room "${room.name}". Use 'crew join' to register first.`,
    );
  }

  // Rename Claude Code session(s)
  try {
    const { getQueue } = await import('../delivery/pane-queue.ts');

    if (oldPane && oldPane !== target) {
      const staleName = `${name}-stale-${randomSuffix()}`;
      void getQueue(oldPane, { role: agent.role })
        .enqueue({
          type: 'paste',
          text: `[system@${agent.room_name}]: pane ownership moved to ${target}; this pane is now stale as ${staleName}`,
        })
        .catch(() => undefined);
      void getQueue(oldPane, { role: agent.role })
        .enqueue({
          type: 'command',
          text: `/rename ${staleName}@${agent.room_name}`,
        })
        .catch(() => undefined);
    }

    void getQueue(target, { role: agent.role })
      .enqueue({
        type: 'command',
        text: `/rename ${name}@${agent.room_name}`,
      })
      .catch(() => undefined);
  } catch {
    // Non-critical — ignore failure
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
