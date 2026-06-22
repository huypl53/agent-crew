import { normalizePath } from "../shared/path-utils.ts";
import type { ToolResult } from "../shared/types.ts";
import { err, ok, randomSuffix } from "../shared/types.ts";
import {
  getAgent,
  getRoom,
  getAgentByRoomAndName,
  getRoomByPath,
  refreshAgent,
} from "../state/index.ts";
import { getPaneCwd, paneExists } from "../tmux/index.ts";
import {
  getRuntimeCommandPrefix,
  resolveAgentRuntime,
} from "../shared/hook-runtime.ts";

interface RefreshParams {
  name: string;
  tmux_target?: string;
}

export async function handleRefresh(
  params: RefreshParams,
): Promise<ToolResult> {
  const { name, tmux_target } = params;

  if (!name) {
    return err("Missing required param: name");
  }

  // Resolve tmux target
  let target = tmux_target;
  if (!target) {
    const pane = process.env.TMUX_PANE;
    if (!pane) {
      return err(
        "Not running inside a tmux pane. Set TMUX_PANE env var, or provide tmux_target param.",
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

  // Try lookup by existing agent globally first (so we know their old room)
  const existingAgent = getAgent(name);
  let room = existingAgent
    ? getRoom(existingAgent.room_id)
    : getRoomByPath(normalizedPath);

  if (!room) {
    return err(
      `Room not found for path: ${normalizedPath}. Use 'crew join' to register first.`,
    );
  }

  const oldAgent = existingAgent || getAgentByRoomAndName(room.id, name);
  const oldPane = oldAgent?.tmux_target ?? null;

  const agent = await refreshAgent(room.id, name, target);
  if (!agent) {
    return err(
      `Agent "${name}" not found in room "${room.name}". Use 'crew join' to register first.`,
    );
  }

  // Rename agent session(s)
  try {
    const { getQueue } = await import("../delivery/pane-queue.ts");

    if (oldPane && oldPane !== target) {
      const staleName = `${name}-stale-${randomSuffix()}`;
      const staleRuntime = await resolveAgentRuntime(agent.agent_type, oldPane);
      // const stalePrefix = getRuntimeCommandPrefix(staleRuntime);
      void getQueue(oldPane, { role: agent.role })
        .enqueue({
          type: "paste",
          text: `[system@${agent.room_name}]: pane ownership moved to ${target}; this pane is now stale as ${staleName}`,
        })
        .catch(() => undefined);
      void getQueue(oldPane, { role: agent.role })
        .enqueue({
          type: "command",
          // text: `${stalePrefix}rename ${staleName}@${agent.room_name}`,
          text: `/rename ${staleName}@${agent.room_name}`,
        })
        .catch(() => undefined);
    }

    const runtime = await resolveAgentRuntime(agent.agent_type, target);
    const commandPrefix = getRuntimeCommandPrefix(runtime);
    void getQueue(target, { role: agent.role })
      .enqueue({
        type: "command",
        // text: `${commandPrefix}rename ${name}@${agent.room_name}`,
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
    room_id: agent.room_id,
    room_path: agent.room_path,
    tmux_target: agent.tmux_target,
  });
}
