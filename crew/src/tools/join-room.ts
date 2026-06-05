import { getPaneStatus } from '../shared/pane-status.ts';
import { normalizePath } from '../shared/path-utils.ts';
import { logServer } from '../shared/server-log.ts';
import type { AgentRole, ToolResult, Room } from '../shared/types.ts';
import { err, generateRandomName, ok, randomSuffix } from '../shared/types.ts';
import {
  addAgent,
  getAgentByRoomAndName,
  getAllAgents,
  getOrCreateRoom,
  getRoom,
  removeAgentFully,
} from '../state/index.ts';
import { getPaneCwd, paneExists } from '../tmux/index.ts';

const VALID_ROLES: AgentRole[] = ['leader', 'worker'];

interface JoinRoomParams {
  room?: string;
  role: string;
  name?: string;
  tmux_target?: string;
  room_id?: number;
}

function getTmuxSocketArgs(): string[] {
  const socket = process.env.CREW_TMUX_SOCKET;
  return socket ? ['-L', socket] : [];
}

interface ProcessInfo {
  comm: string;
  args?: string;
}

export function inferAgentTypeFromProcesses(
  processes: ProcessInfo[],
): 'claude-code' | 'codex' | 'unknown' {
  const normalized = processes.map((process) => ({
    comm: process.comm.trim().toLowerCase(),
    args: process.args?.trim().toLowerCase() ?? '',
  }));

  if (
    normalized.some(
      (process) =>
        process.comm.includes('claude') || process.args.includes('claude'),
    )
  ) {
    return 'claude-code';
  }

  if (
    normalized.some(
      (process) =>
        process.comm.includes('codex') || process.args.includes('codex'),
    )
  ) {
    return 'codex';
  }

  return 'unknown';
}

/** Detect agent type by checking child process name via PID */
export async function detectAgentType(
  paneTarget: string,
): Promise<'claude-code' | 'codex' | 'unknown'> {
  try {
    // Get shell PID from tmux pane
    const shellProc = Bun.spawn(
      [
        'tmux',
        ...getTmuxSocketArgs(),
        'display-message',
        '-p',
        '-t',
        paneTarget,
        '#{pane_pid}',
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const shellPidStr = (await new Response(shellProc.stdout).text()).trim();
    await shellProc.exited;
    const shellPid = Number.parseInt(shellPidStr, 10);
    if (Number.isNaN(shellPid)) return 'unknown';

    const discovered: ProcessInfo[] = [];
    const pending = [shellPid];
    const seen = new Set<number>();

    while (pending.length > 0) {
      const parentPid = pending.shift();
      if (parentPid == null || seen.has(parentPid)) continue;
      seen.add(parentPid);

      const pgrepProc = Bun.spawn(['pgrep', '-P', String(parentPid)], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const childPidOutput = (await new Response(pgrepProc.stdout).text())
        .trim()
        .split('\n');
      await pgrepProc.exited;

      for (const cpid of childPidOutput) {
        if (!cpid.trim()) continue;
        const childPid = Number.parseInt(cpid.trim(), 10);
        if (Number.isNaN(childPid) || seen.has(childPid)) continue;
        pending.push(childPid);

        const commProc = Bun.spawn(['ps', '-p', cpid.trim(), '-o', 'comm='], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const argsProc = Bun.spawn(['ps', '-p', cpid.trim(), '-o', 'args='], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const comm = (await new Response(commProc.stdout).text()).trim();
        const args = (await new Response(argsProc.stdout).text()).trim();
        await commProc.exited;
        await argsProc.exited;

        discovered.push({
          comm,
          args,
        });
      }
    }

    return inferAgentTypeFromProcesses(discovered);
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
  const { role, tmux_target, room_id } = params;

  if (!role) {
    return err('Missing required param: role');
  }

  if (!VALID_ROLES.includes(role as AgentRole)) {
    return err(`Invalid role: ${role}. Must be one of: leader, worker`);
  }

  // Determine tmux target — null means pull-only (no tmux pane)
  let target: string | null = tmux_target ?? null;
  if (!target) {
    const pane = process.env.TMUX_PANE;
    target = pane?.trim() ? pane.trim() : null;
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

  // Generate random name if not provided
  const explicitName = params.name?.trim();
  let name = explicitName || generateRandomName();
  if (!explicitName) {
    name = `${role}-${name}`;
  }

  // Remove any stale agents using the same pane but different name
  for (const agent of getAllAgents()) {
    if (agent.tmux_target === target && agent.name !== name) {
      removeAgentFully(agent.name);
    }
  }

  let roomObj: Room;
  if (room_id !== undefined) {
    const existing = getRoom(room_id);
    if (!existing) {
      return err(`Room with ID ${room_id} does not exist`);
    }
    roomObj = existing;
  } else {
    const room = params.room;
    if (!room) {
      return err('Missing required param: room or room-id');
    }
    roomObj = getOrCreateRoom(normalizedPath, room);
  }

  // Resolve name collisions
  const existing = getAgentByRoomAndName(roomObj.id, name);
  if (existing?.tmux_target && target) {
    if (existing.tmux_target === target) {
      // Same pane — rejoin: update in-place (addAgent handles this)
    } else {
      // Different pane — check if old agent is alive
      const oldPaneAlive = await paneExists(existing.tmux_target);
      if (oldPaneAlive) {
        // Add suffix so new agent can still join
        name = `${name}-${randomSuffix()}`;
      }
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

  // Pre-seed pane status snapshot so first getPaneStatus call has a baseline
  if (target) {
    await getPaneStatus(target).catch((e) => {
      logServer(
        'WARN',
        `Pre-seed status capture failed for ${target}: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  // Rename Claude Code session to agent name
  try {
    if (target) {
      const { getQueue } = await import('../delivery/pane-queue.ts');
      await getQueue(target, { role: role as AgentRole }).enqueue({
        type: 'command',
        text: `/rename ${name}@${roomObj.name}`,
      });
    }
  } catch {
    // Non-critical — ignore failure
  }

  return ok({
    agent_id: agent.agent_id,
    name: agent.name,
    role: agent.role,
    room: roomObj.name,
    room_id: roomObj.id,
    room_path: roomObj.path,
    tmux_target: agent.tmux_target,
    pull_only: target === null,
  });
}
