import { getAgent } from '../state/index.ts';
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
