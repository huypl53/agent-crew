import { err, ok, type ToolResult } from '../shared/types.ts';
import {
  getAgent,
  isAgentAutoSelfOnIdle,
  setAgentAutoSelfOnIdle,
} from '../state/index.ts';

interface AutoSelfParams {
  name: string;
  action: 'on' | 'off';
}

export function handleAutoSelf(params: AutoSelfParams): ToolResult {
  const { name, action } = params;

  if (!name) return err('Missing required param: name');
  if (action !== 'on' && action !== 'off')
    return err(`Unknown action: '${action}'. Use: on, off`);

  const agent = getAgent(name);
  if (!agent) return err(`Agent not found: ${name}`);
  if (agent.role !== 'leader')
    return err(`Auto-self only applies to leaders (got role: ${agent.role})`);

  const enabled = action === 'on';
  if (isAgentAutoSelfOnIdle(name) === enabled) {
    return ok({
      name,
      auto_self_on_idle: enabled,
      note: `Already ${enabled ? 'on' : 'off'}`,
    });
  }

  setAgentAutoSelfOnIdle(name, enabled);
  return ok({
    name,
    auto_self_on_idle: enabled,
    note: enabled
      ? 'crew status --self will auto-trigger when leader goes idle'
      : 'Auto-self on idle disabled',
  });
}
