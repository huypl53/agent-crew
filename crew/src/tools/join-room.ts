import { ok, err } from '../shared/types.ts';
import type { ToolResult, AgentRole } from '../shared/types.ts';
import { addAgent, getAgent, getAllAgents, isNameTakenInRoom, removeAgentFully } from '../state/index.ts';
import { paneExists } from '../tmux/index.ts';
import { logServer } from '../shared/server-log.ts';

const VALID_ROLES: AgentRole[] = ['boss', 'leader', 'worker'];

interface JoinRoomParams {
  room: string;
  role: string;
  name: string;
  tmux_target?: string;
}

/** Detect agent type by checking child process name via PID */
export async function detectAgentType(paneTarget: string): Promise<'claude-code' | 'codex' | 'unknown'> {
  try {
    // Get shell PID from tmux pane
    const shellProc = Bun.spawn(['tmux', 'display-message', '-p', '-t', paneTarget, '#{pane_pid}'], {
      stdout: 'pipe', stderr: 'pipe',
    });
    const shellPidStr = (await new Response(shellProc.stdout).text()).trim();
    await shellProc.exited;
    const shellPid = parseInt(shellPidStr);
    if (isNaN(shellPid)) return 'unknown';

    // Get child process names
    const psProc = Bun.spawn(['ps', '-o', 'comm=', '--ppid', String(shellPid)], {
      stdout: 'pipe', stderr: 'pipe',
    });
    const psOutput = (await new Response(psProc.stdout).text()).trim().toLowerCase();
    await psProc.exited;

    // Fallback: try pgrep + ps approach for macOS
    if (!psOutput) {
      const pgrepProc = Bun.spawn(['pgrep', '-P', String(shellPid)], {
        stdout: 'pipe', stderr: 'pipe',
      });
      const childPids = (await new Response(pgrepProc.stdout).text()).trim().split('\n');
      await pgrepProc.exited;

      for (const cpid of childPids) {
        if (!cpid.trim()) continue;
        const ps2 = Bun.spawn(['ps', '-p', cpid.trim(), '-o', 'comm='], {
          stdout: 'pipe', stderr: 'pipe',
        });
        const comm = (await new Response(ps2.stdout).text()).trim().toLowerCase();
        await ps2.exited;
        if (comm.includes('claude')) return 'claude-code';
        if (comm.includes('codex')) return 'codex';
      }
      return 'unknown';
    }

    if (psOutput.includes('claude')) return 'claude-code';
    if (psOutput.includes('codex')) return 'codex';
    return 'unknown';
  } catch (e) {
    logServer('ERROR', `detectAgentType failed for pane ${paneTarget}: ${e instanceof Error ? e.message : String(e)}`);
    return 'unknown';
  }
}

export async function handleJoinRoom(params: JoinRoomParams): Promise<ToolResult> {
  const { room, role, name, tmux_target } = params;

  if (!room || !role || !name) {
    return err('Missing required params: room, role, name');
  }

  if (!VALID_ROLES.includes(role as AgentRole)) {
    return err(`Invalid role: ${role}. Must be one of: boss, leader, worker`);
  }

  // Determine tmux target — null means pull-only (no tmux pane)
  let target: string | null = tmux_target ?? null;
  if (!target) {
    const pane = process.env.TMUX_PANE;
    target = pane && pane.trim() ? pane.trim() : null;
  }

  if (target === null) {
    // Pull-only join: no tmux pane — register with null pane, skip all tmux steps
    const agent = addAgent(name, role as AgentRole, room, null, 'unknown');
    return ok({
      agent_id: agent.agent_id,
      name: agent.name,
      role: agent.role,
      room,
      tmux_target: null,
      pull_only: true,
    });
  }

  // Validate pane exists
  const exists = await paneExists(target);
  if (!exists) {
    return err(`tmux pane ${target} does not exist`);
  }

  // Evict any stale agent occupying the same pane under a different name
  for (const agent of getAllAgents()) {
    if (agent.tmux_target === target && agent.name !== name) {
      removeAgentFully(agent.name);
    }
  }

  // Check duplicate name — allow overwrite if old pane is dead
  if (isNameTakenInRoom(name, room)) {
    const existing = getAgent(name);
    if (existing) {
      const oldPaneAlive = existing.tmux_target ? await paneExists(existing.tmux_target) : false;
      if (oldPaneAlive && existing.tmux_target !== target) {
        return err(`Name "${name}" is already taken in room "${room}" by a live agent (pane ${existing.tmux_target})`);
      }
    }
    // Old pane is dead, same pane re-registering, or orphaned member row — overwrite
  }

  const agentType = await detectAgentType(target);
  const agent = addAgent(name, role as AgentRole, room, target, agentType);

  return ok({
    agent_id: agent.agent_id,
    name: agent.name,
    role: agent.role,
    room,
    tmux_target: agent.tmux_target,
  });
}
