import { ok, err } from '../shared/types.ts';
import type { ToolResult, AgentRole } from '../shared/types.ts';
import { addAgent, isNameTakenInRoom } from '../state/index.ts';
import { paneExists } from '../tmux/index.ts';

const VALID_ROLES: AgentRole[] = ['boss', 'leader', 'worker'];

interface JoinRoomParams {
  room: string;
  role: string;
  name: string;
  tmux_target?: string;
}

export async function handleJoinRoom(params: JoinRoomParams): Promise<ToolResult> {
  const { room, role, name, tmux_target } = params;

  if (!room || !role || !name) {
    return err('Missing required params: room, role, name');
  }

  if (!VALID_ROLES.includes(role as AgentRole)) {
    return err(`Invalid role: ${role}. Must be one of: boss, leader, worker`);
  }

  // Determine tmux target
  let target = tmux_target;
  if (!target) {
    const tmux = process.env.TMUX;
    const pane = process.env.TMUX_PANE;
    if (!tmux || !pane) {
      return err('Not running inside a tmux pane. Set TMUX and TMUX_PANE env vars, or provide tmux_target param.');
    }
    target = pane; // Use pane ID directly (e.g., %100)
  }

  // Validate pane exists
  const exists = await paneExists(target);
  if (!exists) {
    return err(`tmux pane ${target} does not exist`);
  }

  // Check duplicate name
  if (isNameTakenInRoom(name, room)) {
    return err(`Name "${name}" is already taken in room "${room}"`);
  }

  const agent = addAgent(name, role as AgentRole, room, target);

  return ok({
    agent_id: agent.agent_id,
    name: agent.name,
    role: agent.role,
    room,
    tmux_target: agent.tmux_target,
  });
}
