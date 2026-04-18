import { normalizePath } from '../shared/path-utils.ts';
import { logServer } from '../shared/server-log.ts';
import type { AgentRole, ToolResult } from '../shared/types.ts';
import { err, ok } from '../shared/types.ts';
import {
  addAgent,
  getAgentByRoomAndName,
  getAllAgents,
  getOrCreateRoom,
  removeAgentFully,
} from '../state/index.ts';
import { getPaneCwd, paneExists } from '../tmux/index.ts';

const VALID_ROLES: AgentRole[] = ['boss', 'leader', 'worker'];

interface JoinRoomParams {
  room: string;
  role: string;
  name: string;
  tmux_target?: string;
}

/** Detect agent type by checking child process name via PID */
export async function detectAgentType(
  paneTarget: string,
): Promise<'claude-code' | 'codex' | 'unknown'> {
  try {
    // Get shell PID from tmux pane
    const shellProc = Bun.spawn(
      ['tmux', 'display-message', '-p', '-t', paneTarget, '#{pane_pid}'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const shellPidStr = (await new Response(shellProc.stdout).text()).trim();
    await shellProc.exited;
    const shellPid = parseInt(shellPidStr);
    if (isNaN(shellPid)) return 'unknown';

    // Get child process names
    const psProc = Bun.spawn(
      ['ps', '-o', 'comm=', '--ppid', String(shellPid)],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const psOutput = (await new Response(psProc.stdout).text())
      .trim()
      .toLowerCase();
    await psProc.exited;

    // Fallback: try pgrep + ps approach for macOS
    if (!psOutput) {
      const pgrepProc = Bun.spawn(['pgrep', '-P', String(shellPid)], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const childPids = (await new Response(pgrepProc.stdout).text())
        .trim()
        .split('\n');
      await pgrepProc.exited;

      for (const cpid of childPids) {
        if (!cpid.trim()) continue;
        const ps2 = Bun.spawn(['ps', '-p', cpid.trim(), '-o', 'comm='], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const comm = (await new Response(ps2.stdout).text())
          .trim()
          .toLowerCase();
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
    logServer(
      'ERROR',
      `detectAgentType failed for pane ${paneTarget}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 'unknown';
  }
}

export async function handleJoinRoom(
  params: JoinRoomParams,
): Promise<ToolResult> {
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

  let cwd: string;
  if (target) {
    const exists = await paneExists(target);
    if (!exists) {
      return err(`tmux pane ${target} does not exist`);
    }
    const paneCwd = await getPaneCwd(target);
    if (!paneCwd) {
      return err(`Could not determine CWD for pane ${target}`);
    }
    cwd = paneCwd;
  } else {
    cwd = process.cwd();
  }

  const normalizedPath = normalizePath(cwd);
  const roomObj = getOrCreateRoom(normalizedPath, room);

  for (const agent of getAllAgents()) {
    if (agent.tmux_target === target && agent.name !== name) {
      removeAgentFully(agent.name);
    }
  }

  const existing = getAgentByRoomAndName(roomObj.id, name);
  if (
    existing &&
    existing.tmux_target &&
    target &&
    existing.tmux_target !== target
  ) {
    const oldPaneAlive = await paneExists(existing.tmux_target);
    if (oldPaneAlive) {
      return err(
        `Name "${name}" is already taken in room "${roomObj.name}" by a live agent (pane ${existing.tmux_target})`,
      );
    }
  }

  const agentType = target ? await detectAgentType(target) : 'unknown';
  const agent = addAgent(
    name,
    role as AgentRole,
    roomObj.id,
    target,
    agentType,
  );

  try {
    if (roomObj.topic && target) {
      const { getQueue } = await import('../delivery/pane-queue.ts');
      await getQueue(target, { role: role as AgentRole }).enqueue({
        type: 'paste',
        text: `Room topic: ${roomObj.topic}`,
      });
    }
  } catch (e) {
    logServer(
      'WARN',
      `topic inject failed for ${name} in ${roomObj.name}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return ok({
    agent_id: agent.agent_id,
    name: agent.name,
    role: agent.role,
    room: roomObj.name,
    room_path: roomObj.path,
    tmux_target: agent.tmux_target,
    pull_only: target === null,
  });
}
