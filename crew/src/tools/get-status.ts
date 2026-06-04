import { getPaneStatus } from '../shared/pane-status.ts';
import { logServer } from '../shared/server-log.ts';
import type { Agent, AgentStatus, ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import { getAgent, touchAgentActivity } from '../state/index.ts';
import { isPaneDead } from '../tmux/index.ts';

interface GetStatusParams {
  agent_name?: string;
  name?: string; // calling agent's own identity
}

export async function resolveAgentLiveStatus(
  agent: Agent,
): Promise<AgentStatus> {
  const dead = await isPaneDead(agent.tmux_target);
  if (dead) {
    return 'dead';
  }

  try {
    let result = await getPaneStatus(agent.tmux_target);
    if (result.status === 'unknown') {
      await Bun.sleep(3500);
      result = await getPaneStatus(agent.tmux_target);
    }
    if (result.contentChanged) {
      touchAgentActivity(agent.name);
    }
    return result.status;
  } catch (e) {
    logServer(
      'ERROR',
      `getPaneStatus failed for ${agent.name} (pane ${agent.tmux_target}): ${e instanceof Error ? e.message : String(e)}`,
    );
    return 'unknown';
  }
}

export async function handleGetStatus(
  params: GetStatusParams,
): Promise<ToolResult> {
  const targetName = params.agent_name ?? params.name;

  if (!targetName) {
    return err('Missing required param: agent_name or name');
  }

  const agent = getAgent(targetName);
  if (!agent) {
    return err(`Agent "${targetName}" is not registered`);
  }

  const status = await resolveAgentLiveStatus(agent);

  return ok({
    agent_id: agent.agent_id,
    name: agent.name,
    role: agent.role,
    room: agent.room_name,
    room_path: agent.room_path,
    status,
    tmux_target: agent.tmux_target,
    last_activity_ts: null,
  });
}
