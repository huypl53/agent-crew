import { getPaneStatus } from "../shared/pane-status.ts";
import { normalizePath } from "../shared/path-utils.ts";
import { logServer } from "../shared/server-log.ts";
import type { AgentRole, ToolResult, Room } from "../shared/types.ts";
import { err, generateRandomName, ok, randomSuffix } from "../shared/types.ts";
import {
  detectAgentRuntimeFromPane,
  inferAgentTypeFromProcesses,
  getRuntimeCommandPrefix,
  resolveAgentRuntime,
} from "../shared/hook-runtime.ts";
import {
  addAgent,
  getAgentByRoomAndName,
  getAllAgents,
  getOrCreateRoom,
  getRoom,
  removeAgentFully,
} from "../state/index.ts";
import { getPaneCwd, paneExists } from "../tmux/index.ts";

const VALID_ROLES: AgentRole[] = ["leader", "worker"];

interface JoinRoomParams {
  room?: string;
  role: string;
  name?: string;
  tmux_target?: string;
  room_id?: number;
}

export {
  inferAgentTypeFromProcesses,
  detectAgentRuntimeFromPane as detectAgentType,
};

export async function handleJoinRoom(
  params: JoinRoomParams,
): Promise<ToolResult> {
  const { role, tmux_target, room_id } = params;

  if (!role) {
    return err("Missing required param: role");
  }

  if (!VALID_ROLES.includes(role as AgentRole)) {
    return err(`Invalid role: ${role}. Must be one of: leader, worker`);
  }

  // Determine tmux target — null means pull-only (no tmux pane)
  let target: string | null = tmux_target ?? null;
  if (!target) {
    const pane = process.env.TMUX_PANE;
    target = pane?.trim() ? pane.trim() : null;
  }

  let cwd: string;
  if (target) {
    const exists = await paneExists(target);
    if (!exists) {
      return err(`tmux pane ${target} does not exist`);
    }
    const paneCwd = await getPaneCwd(target);
    if (!paneCwd) {
      return err(`Could not determine CWD for pane ${target}`);
    }
    cwd = paneCwd;
  } else {
    cwd = process.cwd();
  }

  const normalizedPath = normalizePath(cwd);

  // Generate random name if not provided
  const explicitName = params.name?.trim();
  let name = explicitName || generateRandomName();
  if (!explicitName) {
    name = `${role}-${name}`;
  }

  // Remove any stale agents using the same pane but different name
  for (const agent of getAllAgents()) {
    if (agent.tmux_target === target && agent.name !== name) {
      removeAgentFully(agent.name);
    }
  }

  let roomObj: Room;
  if (room_id !== undefined) {
    const existing = getRoom(room_id);
    if (!existing) {
      return err(`Room with ID ${room_id} does not exist`);
    }
    roomObj = existing;
  } else {
    const room = params.room;
    if (!room) {
      return err("Missing required param: room or room-id");
    }
    roomObj = getOrCreateRoom(normalizedPath, room);
  }

  // Resolve name collisions
  const existing = getAgentByRoomAndName(roomObj.id, name);
  if (existing?.tmux_target && target) {
    if (existing.tmux_target === target) {
      // Same pane — rejoin: update in-place (addAgent handles this)
    } else {
      // Different pane — check if old agent is alive
      const oldPaneAlive = await paneExists(existing.tmux_target);
      if (oldPaneAlive) {
        // Add suffix so new agent can still join
        name = `${name}-${randomSuffix()}`;
      }
    }
  }

  const agentType = target
    ? await detectAgentRuntimeFromPane(target)
    : "unknown";
  const agent = addAgent(
    name,
    role as AgentRole,
    roomObj.id,
    target,
    agentType,
  );

  // Pre-seed pane status snapshot so first getPaneStatus call has a baseline
  if (target) {
    await getPaneStatus(target).catch((e) => {
      logServer(
        "WARN",
        `Pre-seed status capture failed for ${target}: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  // Rename agent session to current identity
  try {
    if (target) {
      const { getQueue } = await import("../delivery/pane-queue.ts");
      const runtime = await resolveAgentRuntime(agentType, target);
      // const commandPrefix = getRuntimeCommandPrefix(runtime);
      await getQueue(target, { role: role as AgentRole }).enqueue({
        type: "command",
        text: `/rename ${name}@${roomObj.name}`,
      });
    }
  } catch {
    // Non-critical — ignore failure
  }

  return ok({
    agent_id: agent.agent_id,
    name: agent.name,
    role: agent.role,
    room: roomObj.name,
    room_id: roomObj.id,
    room_path: roomObj.path,
    tmux_target: agent.tmux_target,
    pull_only: target === null,
  });
}
