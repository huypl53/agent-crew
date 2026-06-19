import { flushPushQueueForAgent } from '../delivery/index.ts';
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

  if (explicitName) {
    const agent = getAgent(explicitName);
    if (!agent) {
      return { error: `Agent "${explicitName}" is not registered` };
    }
    return { name: agent.name, room: agent.room_name };
  }

  const pane = process.env.TMUX_PANE ?? null;
  const paneAgent = pane ? getAgentByPane(pane) : undefined;

  if (paneAgent) {
    return { name: paneAgent.name, room: paneAgent.room_name };
  }

  return {
    error:
      'No registered agent found for current pane. Run from a registered agent pane or pass --name explicitly.',
  };
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

  if (
    subcommand === 'on' ||
    subcommand === 'block' ||
    subcommand === 'arm' ||
    subcommand === 'enable'
  ) {
    const mode = params.persist ? 'persist' : 'armed';
    return ok({
      name: target.name,
      room: target.room,
      input_block_mode: setAgentInputBlockMode(target.name, mode),
    });
  }

  if (
    subcommand === 'off' ||
    subcommand === 'unblock' ||
    subcommand === 'disarm' ||
    subcommand === 'disable'
  ) {
    const previousMode = getAgentInputBlockMode(target.name);
    const result = setAgentInputBlockMode(target.name, 'off');

    // Flush pending push messages that accumulated while blocked.
    // If another path (UserPromptSubmit) already cleared armed mode,
    // `previousMode` will be off and we skip duplicate flush.
    const agent = getAgent(target.name);
    if (agent?.tmux_target) {
      const shouldFlush = previousMode !== 'off';
      const flushed = shouldFlush ? await flushPushQueueForAgent(agent) : 0;
      return ok({
        name: target.name,
        room: target.room,
        input_block_mode: result,
        flushed_messages: flushed,
      });
    }

    return ok({
      name: target.name,
      room: target.room,
      input_block_mode: result,
      flushed_messages: 0,
    });
  }

  return err(
    `Unknown input-block subcommand: ${subcommand}. Use: on, off, status, block, unblock`,
  );
}
