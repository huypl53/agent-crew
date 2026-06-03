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
  join       --room <room> --role <role> --name <name>    Register in a room
  leave      --room <room> --name <name>                  Leave a room
  rooms                                                    List all rooms
  members    --room <room>                                List room members
  send       --room <room> (--text <text> | --file <path>) --name <name>    Send a message
             [--to <agent>] [--kind <kind>] [--mode <mode>]
  read       --name <name> [--room <room>] [--limit N]    Read messages
             [--kinds task,completion]
  status     <agent_name> [--name <self>]                 Check agent status
  check      --name <name> [--scopes messages,agents]     Check for changes
  refresh    --name <name>                                Re-register agent
  topic      --room <room> --text <text> --name <name>    Set room topic
  interrupt  --worker <name> --room <room> --name <name>  Interrupt worker
  inspect    --worker <name> --name <leader>              Inspect recent worker turns
             [--room <room>] [--turns N]
  clear      --worker <name> --room <room> --name <name>  Clear worker session
  reassign   --worker <name> --room <room> --text <t>     Replace current assignment
             --name <name>
  create-room --room <name> --name <self> [--topic <t>]   Create a new room
  delete-room --room <name> --confirm --name <self>       Delete room (removes members + messages)
  mute-idle  --name <name>                                Mute idle notifications (leader only)
  unmute-idle --name <name>                               Unmute idle notifications
  pause-polling [--reason <text>]                         Pause sweep delivery (defer to queue)
  resume-polling                                           Resume sweep delivery and flush deferred queue
  polling-status                                           Show sweep pause/busy control state
  set-polling-busy --mode <auto|manual_busy|manual_free> Set busy mode behavior
  hint       set|unset|lookup                              Manage registered-agent hint (auto-detects current agent)
             set "your message" [-c N] (default cadence: 3)
             lookup is read-only; use hook-event for cadence ticking
  wait-idle  --target <pane> [--timeout <ms>]             Wait until pane is idle (stable content)
             [--stable-count N] [--idle-seconds N]        exit 0 = idle, exit 2 = timed out
  serve      [--port N] [--host H] [--summary-interval N] Start browser dashboard server (default port 3456)

Flags:
  --json     Output raw JSON instead of text
  --help     Show this help message`;
}

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
          `${r.name} ${r.member_count} members (${r.roles.leader}l ${r.roles.worker}w)`,
      )
      .join('\n');
  },

  members: (d) => {
    const header = d.topic ? `[${d.room}] ${d.topic}\n` : `[${d.room}]\n`;
    return (
      header +
      d.members.map((m: any) => `  ${m.name} ${m.role} ${m.status}`).join('\n')
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
    if (d.broadcast)
      return `broadcast to ${d.recipients} (${d.delivered} delivered)`;
    return `msg:${d.message_id} ${d.delivered ? 'delivered' : 'queued'}`;
  },

  join: (d) =>
    `Joined ${d.room} as ${d.name} (${d.role}) pane:${d.tmux_target}`,
  leave: () => 'Left room',
  refresh: (d) =>
    `Refreshed ${d.name} room:${d.room ?? d.room_name ?? ''} pane:${d.tmux_target}`,
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
  'pause-polling': (d) =>
    `polling paused=${d.paused} mode=${d.busy_mode}${d.reason ? ` reason:${d.reason}` : ''}`,
  'resume-polling': (d) => `polling paused=${d.paused} mode=${d.busy_mode}`,
  'polling-status': (d) =>
    `polling paused=${d.paused} mode=${d.busy_mode}${d.reason ? ` reason:${d.reason}` : ''}`,
  'set-polling-busy': (d) =>
    `polling busy_mode=${d.busy_mode} paused=${d.paused}`,
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
};
