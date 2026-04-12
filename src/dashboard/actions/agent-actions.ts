import { getAgent, removeAgentFully, cleanupDeadAgentTasks, getTasksForAgent, updateTaskStatus, initDb } from '../../state/index.ts';
import { sendEscape, sendKeys, paneExists } from '../../tmux/index.ts';

let initialized = false;
function ensureDb() {
  if (!initialized) {
    initDb();
    initialized = true;
  }
}

export async function revokeAgent(agentName: string): Promise<string> {
  ensureDb();
  const agent = getAgent(agentName);
  if (!agent) throw new Error(`Agent "${agentName}" not found`);

  // Interrupt active task if any
  const activeTasks = getTasksForAgent(agentName, ['active']);
  for (const task of activeTasks) {
    await sendEscape(agent.tmux_target);
    updateTaskStatus(task.id, 'interrupted', 'Revoked by operator', undefined, 'dashboard');
  }

  // Clean up all remaining tasks
  cleanupDeadAgentTasks(agentName);

  // Remove agent from all rooms
  removeAgentFully(agentName);

  return `Revoked ${agentName}`;
}

export async function interruptAgent(agentName: string): Promise<string> {
  ensureDb();
  const agent = getAgent(agentName);
  if (!agent) throw new Error(`Agent "${agentName}" not found`);

  const activeTasks = getTasksForAgent(agentName, ['active']);
  if (activeTasks.length === 0) {
    throw new Error(`${agentName} has no active task`);
  }

  const alive = await paneExists(agent.tmux_target);
  if (!alive) throw new Error(`${agentName} pane is dead`);

  await sendEscape(agent.tmux_target);
  for (const task of activeTasks) {
    updateTaskStatus(task.id, 'interrupted', 'Interrupted by operator', undefined, 'dashboard');
  }

  return `Interrupted ${agentName} (task #${activeTasks[0]!.id})`;
}

export async function clearAgentSession(agentName: string): Promise<string> {
  ensureDb();
  const agent = getAgent(agentName);
  if (!agent) throw new Error(`Agent "${agentName}" not found`);

  const alive = await paneExists(agent.tmux_target);
  if (!alive) throw new Error(`${agentName} pane is dead`);

  await sendKeys(agent.tmux_target, '/clear');
  // Wait 2s then send refresh
  await new Promise(r => setTimeout(r, 2000));
  await sendKeys(agent.tmux_target, `/crew:refresh --name ${agentName}`);

  return `Cleared ${agentName} session`;
}
