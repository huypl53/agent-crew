import type { ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import {
  getAgent,
  getAgentByPane,
  getAgentInputBlockMode,
  setAgentInputBlockMode,
} from '../state/index.ts';

interface InputBlockParams {
  subcommand?: string;
  name?: string;
  persist?: boolean;
}

function resolveTarget(
  params: InputBlockParams,
): { name: string; room: string } | { error: string } {
  const explicitName = params.name?.trim();
  const pane = process.env.TMUX_PANE ?? null;
  const paneAgent = pane ? getAgentByPane(pane) : undefined;

  if (paneAgent) {
    if (explicitName && explicitName !== paneAgent.name) {
      return {
        error: `Current pane is registered as ${paneAgent.name} in room ${paneAgent.room_name}. Omit --name or target that agent explicitly.`,
      };
    }
    return { name: paneAgent.name, room: paneAgent.room_name };
  }

  if (!explicitName) {
    return {
      error:
        'No registered agent found for current pane. Run from a registered agent pane or pass --name explicitly.',
    };
  }

  const agent = getAgent(explicitName);
  if (!agent) {
    return { error: `Agent "${explicitName}" is not registered` };
  }
  return { name: agent.name, room: agent.room_name };
}

export async function handleInputBlock(
  params: InputBlockParams,
): Promise<ToolResult> {
  const subcommand = params.subcommand ?? 'status';

  const target = resolveTarget(params);
  if ('error' in target) return err(target.error);

  if (subcommand === 'status') {
    return ok({
      name: target.name,
      room: target.room,
      input_block_mode: getAgentInputBlockMode(target.name),
    });
  }

  if (subcommand === 'on' || subcommand === 'block' || subcommand === 'arm' || subcommand === 'enable') {
    const mode = params.persist ? 'persist' : 'armed';
    return ok({
      name: target.name,
      room: target.room,
      input_block_mode: setAgentInputBlockMode(target.name, mode),
    });
  }

  if (subcommand === 'off' || subcommand === 'unblock' || subcommand === 'disarm' || subcommand === 'disable') {
    return ok({
      name: target.name,
      room: target.room,
      input_block_mode: setAgentInputBlockMode(target.name, 'off'),
    });
  }

  return err(`Unknown input-block subcommand: ${subcommand}. Use: on, off, status, block, unblock`);
}
