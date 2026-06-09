export function formatResult(command: string, data: any): string {
  const fn = FORMATTERS[command];
  return fn ? fn(data) : JSON.stringify(data);
}

export function formatError(data: any): string {
  return `Error: ${data.error ?? JSON.stringify(data)}`;
}

export function formatHelp(): string {
  return `crew — multi-agent coordination CLI

Usage: crew <command> [flags]

Commands:
  join        --room <name> --role <role> [--name <name>]  Register in a room (name auto-detected if omitted)
              [--room-id <id>]                             Join room by ID instead of CWD
  leave       --room <name|id|path> [--name <name>]        Leave a room
  rooms                                                    List all rooms
  members     --room <name|id|path>                        List room members
  send        --room <name|id|path> (--text <text> | --file <path>) [--name <name>]
              [--to <agent>] [--kind <kind>] [--mode <mode>] Send a message
  read        [--name <name>] [--room <name|id|path>] [--limit N]
              [--kinds task,completion]                    Read messages
  status      <agent_name> [--name <self>]                 Check agent status
  check       [--name <name>] [--scopes messages,agents]   Check for changes
  refresh     [--name <name>]                              Re-register agent
  topic       --room <name|id|path> --text <text> [--name <name>] Set room topic
  interrupt   --worker <name> --room <name|id|path> [--name <name>] Interrupt worker
  inspect     --worker <name> [--name <leader>]            Inspect recent worker turns
              [--room <name|id|path>] [--turns N]
  clear       --worker <name> --room <name|id|path> [--name <name>] Clear worker session
  reassign    --worker <name> --room <name|id|path> --text <t> [--name <name>]
              Replace current assignment
  create-room --room <name> [--name <self>] [--topic <t>]  Create a new room
  delete-room [<name|id|path>] --confirm [--name <self>]   Delete room (removes members + messages)
  manage      [--name <self>]                              Interactive room/member management console

  input-block [on|off|status] [--name <agent>] [--persist] Manage input-block mode (alias: ib)

  mute        idle [--name <name>]                         Mute idle notifications (leader only)
  unmute      idle [--name <name>]                         Unmute idle notifications

  polling     pause [--reason <text>]                      Pause sweep delivery
  polling     resume                                       Resume sweep delivery & flush queue
  polling     status                                       Show sweep status
  polling     busy <auto|manual_busy|manual_free>         Set busy mode behavior

  hint        set|unset|lookup                             Manage registered-agent hint
              set "your message" [-c N] (default cadence: 3)
  wait-idle   --target <pane> [--timeout <ms>]             Wait until pane is idle (stable content)
              [--stable-count N] [--idle-seconds N]
  serve       [--port N] [--host H] [--summary-interval N] Start browser dashboard server (default port 3456)

Flags:
  --json      Output raw JSON instead of text
  --help      Show this help message`;
}

const formatInputBlock = (d: any) =>
  `${d.name} input-block:${d.input_block_mode}`;

const FORMATTERS: Record<string, (data: any) => string> = {
  check: (d) =>
    Object.entries(d.scopes)
      .map(
        ([k, v]: [string, any]) =>
          `${k}:${typeof v === 'object' ? v.version : v}`,
      )
      .join(' '),

  status: (d) => {
    return `${d.name} ${d.status} ${d.tmux_target} ${d.room_name ?? d.room ?? ''}${d.room_path ? ` (${d.room_path})` : ''}`;
  },

  rooms: (d) => {
    if (!d.rooms?.length) return '(no rooms)';
    return d.rooms
      .map(
        (r: any) =>
          `[ID: ${r.id}] ${r.name} (${r.path}) ${r.member_count} members (${r.roles.leader}l ${r.roles.worker}w)`,
      )
      .join('\n');
  },

  members: (d) => {
    const header = d.topic ? `[${d.room}] ${d.topic}\n` : `[${d.room}]\n`;
    return (
      header +
      d.members
        .map(
          (m: any) =>
            `  ${m.name} ${m.role} ${m.status} input-block:${m.input_block_mode ?? 'off'}`,
        )
        .join('\n')
    );
  },

  read: (d) => {
    if (!d.messages?.length) return '(no messages)';
    return d.messages
      .map((m: any) => {
        const to = m.to ? `→${m.to}` : '';
        const kind = m.kind !== 'chat' ? `(${m.kind})` : '';
        return `[${m.from}@${m.room}${to}]${kind}: ${m.text}`;
      })
      .join('\n');
  },

  send: (d) => {
    let base = '';
    if (d.broadcast) {
      base = `broadcast to ${d.recipients} (${d.delivered} delivered)`;
    } else {
      base = `msg:${d.message_id} ${d.delivered ? 'delivered' : 'queued'}`;
    }

    if (d.members && d.members.length > 0) {
      const membersStr = d.members
        .map(
          (m: any) =>
            `  ${m.name} ${m.role} ${m.status} input-block:${m.input_block_mode ?? 'off'}`,
        )
        .join('\n');
      return `${base}\nMembers:\n${membersStr}`;
    }
    return base;
  },

  join: (d) =>
    `Joined ${d.room} (ID: ${d.room_id}) as ${d.name} (${d.role}) pane:${d.tmux_target}`,
  'input-block': formatInputBlock,
  ib: formatInputBlock,
  block: formatInputBlock,
  unblock: formatInputBlock,
  leave: () => 'Left room',
  refresh: (d) =>
    `Refreshed ${d.name} room:${d.room ?? d.room_name ?? ''} (ID: ${d.room_id ?? ''}) pane:${d.tmux_target}`,
  topic: (d) => `Topic set: ${d.topic}`,
  interrupt: () => 'Interrupted worker',
  inspect: (d) => {
    const lines = [
      `worker: ${d.agent_name}`,
      `room: ${d.room_name}`,
      `provider: ${d.provider}`,
      `session_id: ${d.session_id ?? 'null'}`,
      `status: ${d.status}`,
      `updated_at: ${d.updated_at ?? 'null'}`,
      `block_hint: ${d.block_hint}`,
      `source: ${d.source}`,
    ];
    if (d.degraded) {
      lines.push(`degraded: true`);
      lines.push(`degradation_reason: ${d.degradation_reason}`);
    }
    if (Array.isArray(d.turns) && d.turns.length > 0) {
      lines.push('');
      for (const turn of d.turns) {
        lines.push(`[${turn.role}] ${turn.text}`);
      }
    }
    return lines.join('\n');
  },
  clear: (d) => `Cleared ${d.worker_name} session`,
  reassign: () => 'Sent replacement assignment',
  'create-room': (d) =>
    `Created room: ${d.room}${d.topic ? ` (${d.topic})` : ''}`,
  'delete-room': (d) =>
    `Deleted room: ${d.room} (${d.removed_members.length} members removed, ${d.messages_deleted} messages deleted)`,
  'mute-idle': (d) =>
    `${d.name} idle notifications ${d.idle_muted ? 'muted' : 'unmuted'}. ${d.note ?? ''}`,
  'unmute-idle': (d) =>
    `${d.name} idle notifications ${d.idle_muted ? 'muted' : 'unmuted'}. ${d.note ?? ''}`,
  mute: (d) =>
    `${d.name} idle notifications ${d.idle_muted ? 'muted' : 'unmuted'}. ${d.note ?? ''}`,
  unmute: (d) =>
    `${d.name} idle notifications ${d.idle_muted ? 'muted' : 'unmuted'}. ${d.note ?? ''}`,
  'pause-polling': (d) =>
    `polling paused=${d.paused} mode=${d.busy_mode}${d.reason ? ` reason:${d.reason}` : ''}`,
  'resume-polling': (d) => `polling paused=${d.paused} mode=${d.busy_mode}`,
  'polling-status': (d) =>
    `polling paused=${d.paused} mode=${d.busy_mode}${d.reason ? ` reason:${d.reason}` : ''}`,
  'set-polling-busy': (d) =>
    `polling busy_mode=${d.busy_mode} paused=${d.paused}`,
  polling: (d) =>
    `polling paused=${d.paused} mode=${d.busy_mode}${d.reason ? ` reason:${d.reason}` : ''}`,
  hint: (d) => {
    if (d.error) return `Error: ${d.error}`;
    if (d.hint?.status) return d.hint.status;
    if (d.hint?.message) return d.hint.message;
    if (d.message) return d.message;
    if (d.hint?.agent_name) return `Registered agent: ${d.hint.agent_name}`;
    return '(no hint)';
  },
  'hook-event': (d) => {
    // Hook stdout is injected into Claude Code conversations.
    // Emit reminder text only when a hint is due; otherwise stay silent.
    if (d.hint?.message) return d.hint.message;
    return '';
  },
  party: (d) => {
    if (d.started) {
      return `Started party round ${d.round} on topic: "${d.topic}"\nWorkers: ${d.workers.join(', ')}`;
    }
    if (d.ended) {
      return `Ended party. Completed ${d.rounds_completed} rounds`;
    }
    if (d.round && d.topic) {
      return `Advanced to round ${d.round} on topic: "${d.topic}"\nWorkers: ${d.workers.join(', ')}`;
    }
    if (d.skipped) {
      return `Skipped worker ${d.skipped}. Pending: ${d.pending.join(', ') || '(none)'}`;
    }
    if (d.active === false) {
      return 'No active party mode in this room';
    }
    if (d.active === true) {
      return `Active party round ${d.round} on topic: "${d.topic}"\nResponded: ${d.responded.join(', ') || '(none)'}\nPending: ${d.pending.join(', ') || '(none)'}`;
    }
    return JSON.stringify(d);
  },
  manage: () => 'Management console exited',
};
