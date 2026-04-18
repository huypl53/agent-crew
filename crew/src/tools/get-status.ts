import { ok, err } from '../shared/types.ts';
import type { ToolResult, AgentStatus } from '../shared/types.ts';
import { getAgent, touchAgentActivity, getTasksForAgent } from '../state/index.ts';
import { isPaneDead } from '../tmux/index.ts';
import { getPaneStatus } from '../shared/pane-status.ts';
import { logServer } from '../shared/server-log.ts';

interface GetStatusParams {
  agent_name?: string;
  name?: string; // calling agent's own identity
}

export async function handleGetStatus(params: GetStatusParams): Promise<ToolResult> {
  const targetName = params.agent_name ?? params.name;

  if (!targetName) {
    return err('Missing required param: agent_name or name');
  }

  const agent = getAgent(targetName);
  if (!agent) {
    return err(`Agent "${targetName}" is not registered`);
  }

  // Get task info (before dead check — dead agents may still have tasks)
  const activeTasks = getTasksForAgent(targetName, ['active']);
  const queuedTasks = getTasksForAgent(targetName, ['queued', 'sent']);
  const currentTask = activeTasks.length > 0 ? {
    id: activeTasks[0]!.id, status: activeTasks[0]!.status, summary: activeTasks[0]!.summary,
  } : null;
  const queuedTasksList = queuedTasks.map(t => ({ id: t.id, status: t.status, summary: t.summary }));

  // Check liveness first
  const dead = await isPaneDead(agent.tmux_target);
  if (dead) {
    return ok({
      agent_id: agent.agent_id,
      name: agent.name,
      role: agent.role,
      room: agent.room_name,
      status: 'dead' as AgentStatus,
      tmux_target: agent.tmux_target,
      last_activity_ts: null,
      current_task: currentTask,
      queued_tasks: queuedTasksList,
    });
  }

  // Hash + PID based status — no DB fallback (DB status is unreliable, agents don't self-report)
  let status: AgentStatus;
  try {
    const result = await getPaneStatus(agent.tmux_target);
    status = result.status;
    if (result.contentChanged) {
      touchAgentActivity(targetName);
    }
  } catch (e) {
    logServer('ERROR', `getPaneStatus failed for ${targetName} (pane ${agent.tmux_target}): ${e instanceof Error ? e.message : String(e)}`);
    status = 'unknown';
  }

  return ok({
    agent_id: agent.agent_id,
    name: agent.name,
    role: agent.role,
    room: agent.room_name,
    status,
    tmux_target: agent.tmux_target,
    last_activity_ts: null,
    current_task: currentTask,
    queued_tasks: queuedTasksList,
  });
}
