import { ok, err } from '../shared/types.ts';
import type { ToolResult, AgentStatus } from '../shared/types.ts';
import { getAgent, getAgentDbStatus, getTasksForAgent } from '../state/index.ts';
import { capturePane, isPaneDead } from '../tmux/index.ts';
import { matchStatusLine } from '../shared/status-patterns.ts';
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
      rooms: agent.rooms,
      status: 'dead' as AgentStatus,
      tmux_target: agent.tmux_target,
      last_activity_ts: agent.last_activity ?? agent.joined_at,
      current_task: currentTask,
      queued_tasks: queuedTasksList,
    });
  }

  // Prefer DB-driven status (set atomically on message write) over pane capture
  const dbStatus = getAgentDbStatus(targetName);
  let status: AgentStatus;
  if (dbStatus === 'busy' || dbStatus === 'idle') {
    status = dbStatus;
  } else {
    // Fall back to pane capture (sweep safety net for agents with no message history)
    let output: string | null = null;
    try {
      output = await capturePane(agent.tmux_target);
    } catch (e) {
      logServer('ERROR', `capturePane failed for ${targetName} (pane ${agent.tmux_target}): ${e instanceof Error ? e.message : String(e)}`);
    }
    status = output !== null ? matchStatusLine(output) : 'unknown';
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
