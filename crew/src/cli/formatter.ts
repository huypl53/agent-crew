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
  send       --room <room> --text <text> --name <name>    Send a message
             [--to <agent>] [--kind <kind>] [--mode <mode>]
  read       --name <name> [--room <room>] [--limit N]    Read messages
             [--kinds task,completion]
  status     <agent_name> [--name <self>]                 Check agent status
  check      --name <name> [--scopes messages,tasks]      Check for changes
  refresh    --name <name>                                Re-register agent
  topic      --room <room> --text <text> --name <name>    Set room topic
  update-task --task <id> --status <s> --name <name>      Update task status
  interrupt  --worker <name> --room <room> --name <name>  Interrupt worker
  clear      --worker <name> --room <room> --name <name>  Clear worker session
  reassign   --worker <name> --room <room> --text <t>     Reassign task
             --name <name>
  task-details <task_id>                                  Get task details
  search-tasks [--room <r>] [--keyword <k>] [--status <s>] Search tasks
  create-room --room <name> --name <self> [--topic <t>]   Create a new room
  delete-room --room <name> --confirm --name <self>       Delete room (removes members + messages)

Flags:
  --json     Output raw JSON instead of text
  --help     Show this help message`;
}

const FORMATTERS: Record<string, (data: any) => string> = {
  check: (d) => Object.entries(d.scopes).map(([k, v]: [string, any]) => `${k}:${typeof v === 'object' ? v.version : v}`).join(' '),

  status: (d) => {
    const task = d.current_task ? ` task:#${d.current_task.id}(${d.current_task.status})` : '';
    const queued = d.queued_tasks?.length ? ` queued:${d.queued_tasks.length}` : '';
    return `${d.name} ${d.status} ${d.tmux_target} ${d.rooms?.join(',')}${task}${queued}`;
  },

  rooms: (d) => {
    if (!d.rooms?.length) return '(no rooms)';
    return d.rooms.map((r: any) =>
      `${r.name} ${r.member_count} members (${r.roles.boss}b ${r.roles.leader}l ${r.roles.worker}w)`
    ).join('\n');
  },

  members: (d) => {
    const header = d.topic ? `[${d.room}] ${d.topic}\n` : `[${d.room}]\n`;
    return header + d.members.map((m: any) => `  ${m.name} ${m.role} ${m.status}`).join('\n');
  },

  read: (d) => {
    if (!d.messages?.length) return '(no messages)';
    return d.messages.map((m: any) => {
      const to = m.to ? `→${m.to}` : '';
      const kind = m.kind !== 'chat' ? `(${m.kind})` : '';
      return `[${m.from}@${m.room}${to}]${kind}: ${m.text}`;
    }).join('\n');
  },

  send: (d) => {
    if (d.broadcast) return `broadcast to ${d.recipients} (${d.delivered} delivered)`;
    const task = d.task_id ? ` task:#${d.task_id}` : '';
    return `msg:${d.message_id} ${d.delivered ? 'delivered' : 'queued'}${task}`;
  },

  join: (d) => `Joined ${d.room} as ${d.name} (${d.role}) pane:${d.tmux_target}`,
  leave: () => 'Left room',
  refresh: (d) => `Refreshed ${d.name} rooms:${d.rooms?.join(',')} pane:${d.tmux_target}`,
  topic: (d) => `Topic set: ${d.topic}`,
  'update-task': (d) => `task:#${d.task_id} → ${d.status}`,
  interrupt: (d) => `Interrupted task:#${d.task_id} (was ${d.previous_status})`,
  clear: (d) => `Cleared ${d.worker_name} session`,
  reassign: (d) => `Reassigned: old:#${d.old_task_id ?? 'none'} → new:#${d.new_task_id}`,
  'task-details': (d) => {
    let out = `#${d.id} [${d.status}] ${d.assigned_to} — ${d.summary}`;
    if (d.context) out += `\nContext: ${d.context}`;
    if (d.note) out += `\nNote: ${d.note}`;
    return out;
  },
  'search-tasks': (d) => {
    if (!d.tasks?.length) return '(no tasks found)';
    return d.tasks.map((t: any) => `#${t.id} [${t.status}] ${t.assigned_to} — ${t.summary}`).join('\n');
  },
  'create-room': (d) => `Created room: ${d.room}${d.topic ? ` (${d.topic})` : ''}`,
  'delete-room': (d) => `Deleted room: ${d.room} (${d.removed_members.length} members removed, ${d.messages_deleted} messages deleted)`,
};
