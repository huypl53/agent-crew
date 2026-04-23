import { err, ok, type ToolResult } from '../shared/types.ts';
import {
  getAgent,
  isAgentIdleMuted,
  setAgentIdleMuted,
} from '../state/index.ts';

interface MuteIdleParams {
  name: string;
  action: 'mute' | 'unmute';
}

export function handleMuteIdle(params: MuteIdleParams): ToolResult {
  const { name, action } = params;

  if (!name) return err('Missing required param: name');

  const agent = getAgent(name);
  if (!agent) return err(`Agent not found: ${name}`);
  if (agent.role !== 'leader')
    return err(
      `Only leaders can mute idle notifications (got role: ${agent.role})`,
    );

  const muted = action === 'mute';
  if (isAgentIdleMuted(name) === muted) {
    return ok({
      name,
      idle_muted: muted,
      note: `Already ${muted ? 'muted' : 'unmuted'}`,
    });
  }

  setAgentIdleMuted(name, muted);
  return ok({
    name,
    idle_muted: muted,
    note: muted
      ? 'Idle notifications from workers will no longer be pushed to this leader'
      : 'Idle notifications from workers will resume for this leader',
  });
}
