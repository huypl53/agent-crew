export type AgentRuntime = 'claude-code' | 'codex' | 'unknown';

export interface ProcessInfo {
  comm: string;
  args?: string;
}

type HookEventCandidate = unknown;

/**
 * Prefix for SKILL/prompt invocations only (e.g. `crew:leader`, `crew:worker`).
 * Claude Code uses `/`, Codex uses `$`.
 *
 * This is NOT the prefix for the two other command categories:
 *  - built-in REPL commands (`/clear`, `/compact`, `/rename`) → always `/` in every runtime
 *  - CLI subcommands (`crew refresh`, `crew goal done`) → always `!` (see `crew-command` queue type)
 */
const SKILL_PREFIX_BY_RUNTIME: Record<AgentRuntime, '$' | '/'> = {
  'claude-code': '/',
  codex: '$',
  unknown: '/',
};

const EVENT_KEYS: string[] = [
  'hook_event_name',
  'event',
  'eventName',
  'event_name',
  'event_type',
  'type',
  'hookEventName',
  'hook_event_type',
];

export function normalizeHookEventName(raw: HookEventCandidate): string {
  if (typeof raw !== 'string') return 'Unknown';
  const token = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');

  switch (token) {
    case 'stops':
    case 'stop':
      return 'Stop';
    case 'userpromptsubmit':
    case 'userpromptsubmitevent':
      return 'UserPromptSubmit';
    case 'permissionrequest':
    case 'permissionrequestevent':
    case 'permission':
      return 'PermissionRequest';
    case 'stopfailure':
      return 'StopFailure';
    case 'subagentstop':
      return 'SubagentStop';
    case 'subagentstart':
      return 'SubagentStart';
    default:
      return 'Unknown';
  }
}

export function resolveHookEventName(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    return normalizeHookEventName(payload as HookEventCandidate);
  }

  const obj = payload as Record<string, unknown>;
  for (const key of EVENT_KEYS) {
    const resolved = normalizeHookEventName(obj[key]);
    if (resolved !== 'Unknown') return resolved;
  }

  return 'Unknown';
}

function extractTextFromValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = extractTextFromValue(item);
      if (extracted) return extracted;
    }
    return null;
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('text' in obj) {
      const text = extractTextFromValue(obj.text);
      if (text) return text;
    }
    if ('content' in obj) {
      const content = extractTextFromValue(obj.content);
      if (content) return content;
    }
    if ('message' in obj) {
      const message = extractTextFromValue(obj.message);
      if (message) return message;
    }
    return null;
  }

  return null;
}

const MESSAGE_CANDIDATES = [
  'last_assistant_message',
  'lastAssistantMessage',
  'assistant_message',
  'assistantMessage',
  'assistant',
  'message',
  'output',
  'response',
  'result',
  'final_message',
  'finalMessage',
  'text',
  'content',
];

export function extractHookCompletionMessage(payload: string | null): string {
  if (!payload) return '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return '';
  }

  if (!parsed || typeof parsed !== 'object') {
    return '';
  }

  const obj = parsed as Record<string, unknown>;

  for (const key of MESSAGE_CANDIDATES) {
    const value = extractTextFromValue(obj[key]);
    if (value) return value;
  }

  return '';
}

export function getRuntimeSkillPrefix(runtime: AgentRuntime): '$' | '/' {
  return SKILL_PREFIX_BY_RUNTIME[runtime] ?? '/';
}

function getTmuxSocketArgs(): string[] {
  const socket = process.env.CREW_TMUX_SOCKET;
  return socket ? ['-L', socket] : [];
}

function resolveRuntimeFromCommand(command: string): AgentRuntime {
  const normalized = command.trim().toLowerCase();
  if (normalized === '') return 'unknown';
  if (
    normalized === 'claude' ||
    normalized.startsWith('claude') ||
    normalized.includes('/claude')
  ) {
    return 'claude-code';
  }
  if (
    normalized === 'codex' ||
    normalized.startsWith('codex') ||
    normalized.includes('/codex')
  ) {
    return 'codex';
  }
  return 'unknown';
}

async function readProcessInfo(pid: number): Promise<ProcessInfo | null> {
  const commProc = Bun.spawn(['ps', '-p', String(pid), '-o', 'comm='], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const argsProc = Bun.spawn(['ps', '-p', String(pid), '-o', 'args='], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const comm = (await new Response(commProc.stdout).text()).trim();
  const args = (await new Response(argsProc.stdout).text()).trim();
  await commProc.exited;
  await argsProc.exited;

  if (!comm && !args) return null;
  return { comm, args };
}

export function inferAgentTypeFromProcesses(
  processes: ProcessInfo[],
): AgentRuntime {
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

export async function detectAgentRuntimeFromPane(
  paneTarget: string,
): Promise<'claude-code' | 'codex' | 'unknown'> {
  try {
    const currentCommandProc = Bun.spawn(
      [
        'tmux',
        ...getTmuxSocketArgs(),
        'display-message',
        '-p',
        '-t',
        paneTarget,
        '#{pane_current_command}',
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const currentCommand = (await new Response(currentCommandProc.stdout).text()).trim();
    await currentCommandProc.exited;
    const fromCurrent = resolveRuntimeFromCommand(currentCommand);
    if (fromCurrent !== 'unknown') return fromCurrent;

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
    const rootProcess = await readProcessInfo(shellPid);
    if (rootProcess) {
      discovered.push(rootProcess);
    }

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

        const process = await readProcessInfo(childPid);
        if (process) {
          discovered.push(process);
        }
      }
    }

    return inferAgentTypeFromProcesses(discovered);
  } catch {
    return 'unknown';
  }
}

export async function resolveAgentRuntime(
  agentType: AgentRuntime,
  paneTarget?: string | null,
): Promise<AgentRuntime> {
  if (agentType !== 'unknown' || !paneTarget) {
    return agentType;
  }

  try {
    const detected = await detectAgentRuntimeFromPane(paneTarget);
    return detected;
  } catch {
    return agentType;
  }
}
