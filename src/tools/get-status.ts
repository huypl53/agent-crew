import { ok, err } from '../shared/types.ts';
import type { ToolResult, AgentStatus } from '../shared/types.ts';
import { getAgent, getTasksForAgent } from '../state/index.ts';
import { capturePane, isPaneDead } from '../tmux/index.ts';
import { matchStatusLine } from '../shared/status-patterns.ts';

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
      rooms: agent.rooms,
      status: 'dead' as AgentStatus,
      tmux_target: agent.tmux_target,
      last_activity_ts: agent.last_activity ?? agent.joined_at,
      current_task: currentTask,
      queued_tasks: queuedTasksList,
    });
  }

  // Capture pane and match status
  const output = await capturePane(agent.tmux_target);
  let status: AgentStatus = 'unknown';
  if (output !== null) {
    status = matchStatusLine(output);
  }

  return ok({
    agent_id: agent.agent_id,
    name: agent.name,
    role: agent.role,
    rooms: agent.rooms,
    status,
    tmux_target: agent.tmux_target,
    last_activity_ts: agent.last_activity ?? agent.joined_at,
    current_task: currentTask,
    queued_tasks: queuedTasksList,
  });
}
