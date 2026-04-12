import { getAgent, updateTaskStatus, createTask } from '../../state/index.ts';
import { sendEscape, sendKeys } from '../../tmux/index.ts';
import type { Task } from '../../shared/types.ts';

export async function interruptTask(task: Task): Promise<string> {
  if (task.status !== 'active') {
    throw new Error(`Cannot interrupt task #${task.id} — status is "${task.status}", must be "active"`);
  }
  const agent = getAgent(task.assigned_to);
  if (!agent) throw new Error(`Agent "${task.assigned_to}" not found`);

  await sendEscape(agent.tmux_target);
  updateTaskStatus(task.id, 'interrupted', 'Interrupted by operator', undefined, 'dashboard');
  return `Interrupted task #${task.id} (${task.assigned_to})`;
}

export async function cancelTask(task: Task): Promise<string> {
  if (task.status !== 'queued') {
    throw new Error(`Cannot cancel task #${task.id} — status is "${task.status}", must be "queued"`);
  }
  updateTaskStatus(task.id, 'cancelled', 'Cancelled by operator', undefined, 'dashboard');
  return `Cancelled task #${task.id}`;
}

export async function reassignTask(task: Task, newText: string): Promise<string> {
  const agent = getAgent(task.assigned_to);
  if (!agent) throw new Error(`Agent "${task.assigned_to}" not found`);

  if (task.status === 'active') {
    await sendEscape(agent.tmux_target);
    updateTaskStatus(task.id, 'interrupted', 'Reassigned by operator', undefined, 'dashboard');
  } else if (task.status === 'queued') {
    updateTaskStatus(task.id, 'cancelled', 'Reassigned by operator', undefined, 'dashboard');
  }

  const newTask = createTask(task.room, task.assigned_to, 'dashboard', null, newText);
  await sendKeys(agent.tmux_target, newText);
  return `Reassigned: old #${task.id} → new #${newTask.id}`;
}
