import { getAgent, getAgentByRoomAndName, getRoom } from '../state/index.ts';
import type { Agent, AgentRole } from './types.ts';

export function assertRole(
  callerName: string,
  allowedRoles: AgentRole[],
  action: string,
): Agent {
  const agent = getAgent(callerName);
  if (!agent) {
    throw new Error(`Agent "${callerName}" is not registered`);
  }
  if (!allowedRoles.includes(agent.role)) {
    throw new Error(
      `Only ${allowedRoles.join('/')} can ${action}. You are registered as ${agent.role}.`,
    );
  }
  return agent;
}

export function assertAgentCanInspectWorker(
  workerName: string,
  roomName: string,
  callerName: string,
): { caller: Agent; worker: Agent } {
  const room = getRoom(roomName);
  if (!room) {
    throw new Error(`Room "${roomName}" not found`);
  }

  const latestCaller = getAgent(callerName);
  if (!latestCaller) {
    throw new Error(`Agent "${callerName}" is not registered`);
  }
  if (latestCaller.role !== 'leader') {
    throw new Error('Only leaders can inspect workers');
  }

  const caller = getAgentByRoomAndName(room.id, callerName);
  if (!caller || caller.role !== 'leader') {
    throw new Error(
      `Leader "${callerName}" must be a member of room "${roomName}" to inspect workers there`,
    );
  }

  const worker = getAgentByRoomAndName(room.id, workerName);
  if (!worker) {
    throw new Error(`Worker "${workerName}" not found in room "${roomName}"`);
  }
  if (worker.role !== 'worker') {
    throw new Error(`Target "${workerName}" is not a worker`);
  }

  return { caller, worker };
}
