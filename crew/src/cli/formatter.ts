export function formatResult(command: string, data: any): string {
  const fn = FORMATTERS[command];
  return fn ? fn(data) : JSON.stringify(data);
}

export function formatError(data: any): string {
  return `Error: ${data.error ?? JSON.stringify(data)}`;
}

// ---------------------------------------------------------------------------
// Structured help renderer
// ---------------------------------------------------------------------------

interface HelpEntry {
  /** e.g. "join" or "polling pause" */
  name: string;
  /** first-line usage flags/args; empty string if none */
  usage: string;
  /** short description */
  desc: string;
  /** additional usage lines shown below the first line */
  cont?: string[];
}

interface HelpGroup {
  heading: string;
  entries: HelpEntry[];
}

const HELP_GROUPS: HelpGroup[] = [
  {
    heading: "Room",
    entries: [
      {
        name: "join",
        usage: "--room <name> --role <role> [--name <name>]",
        desc: "Register in a room (name auto-detected if omitted)",
        cont: ["[--room-id <id>]"],
      },
      {
        name: "leave",
        usage: "--room <name|id|path> [--name <name>]",
        desc: "Leave a room",
      },
      { name: "rooms", usage: "", desc: "List all rooms" },
      {
        name: "members",
        usage: "--room <name|id|path>",
        desc: "List room members",
      },
      {
        name: "create-room",
        usage: "--room <name> [--name <self>] [--topic <t>]",
        desc: "Create a new room",
      },
      {
        name: "delete-room",
        usage: "[<name|id|path>] --confirm [--name <self>]",
        desc: "Delete room (removes members + messages)",
      },
      {
        name: "manage",
        usage: "[--name <self>]",
        desc: "Interactive room/member console",
      },
    ],
  },
  {
    heading: "Messaging",
    entries: [
      {
        name: "send",
        usage: "--room <name> (--text <t> | --file <f>)",
        desc: "Send a message",
        cont: ["[--to <agent>] [--kind <kind>] [--mode <mode>]"],
      },
      {
        name: "send-batch",
        usage: "--room <name> --manifest <path> --name <name>",
        desc: "Send batch messages to workers",
        cont: ["[--mode <mode>]"],
      },
      {
        name: "read",
        usage: "[--name <name>] [--room <name>] [--limit N]",
        desc: "Consume queued messages (advances cursor)",
        cont: ["[--kinds task,completion]"],
      },
      {
        name: "topic",
        usage: "--room <name|id|path> --text <text> [--name <name>]",
        desc: "Set room topic",
      },
    ],
  },
  {
    heading: "Status",
    entries: [
      {
        name: "status",
        usage: "[<agent>] [--self] [--inline] [--json]",
        desc: "Check agent status (--self for rich view)",
        cont: ["[--session <id>] [--name <self>]"],
      },
      {
        name: "check",
        usage: "[--name <name>] [--scopes messages,agents]",
        desc: "Poll version counters (lightweight)",
      },
    ],
  },
  {
    heading: "Control",
    entries: [
      {
        name: "polling pause",
        usage: "[--reason <text>]",
        desc: "Pause sweep delivery",
      },
      {
        name: "polling resume",
        usage: "",
        desc: "Resume sweep delivery & flush queue",
      },
      { name: "polling status", usage: "", desc: "Show sweep status" },
      {
        name: "polling busy",
        usage: "<auto|manual_busy|manual_free>",
        desc: "Set busy mode behavior",
      },
      {
        name: "input-block",
        usage: "[on|off|status] [--name <agent>] [--persist]",
        desc: "Manage input-block mode (alias: ib)",
      },
      {
        name: "mute idle",
        usage: "[--name <name>]",
        desc: "Mute idle notifications (leader only)",
      },
      {
        name: "unmute idle",
        usage: "[--name <name>]",
        desc: "Unmute idle notifications",
      },
      {
        name: "auto-self",
        usage: "on|off [--name <leader>]",
        desc: "Toggle auto --self on leader idle",
      },
    ],
  },
  {
    heading: "Agent",
    entries: [
      {
        name: "hint set",
        usage: '"your message" [-c N]',
        desc: "Register agent hint (cadence: 3)",
      },
      { name: "hint unset", usage: "", desc: "Clear registered agent hint" },
      { name: "hint lookup", usage: "", desc: "Show registered agent hint" },
      {
        name: "goal set",
        usage: '"description" [--agent <name> --room <name>]',
        desc: "Set agent goal",
      },
      {
        name: "goal done",
        usage: "[--agent <name> --room <name>]",
        desc: "Mark agent goal complete",
      },
      {
        name: "goal update",
        usage: '"new desc" [--agent <name> --room <name>]',
        desc: "Update agent goal description",
      },
      {
        name: "goal unset",
        usage: "[--agent <name> --room <name>]",
        desc: "Remove agent goal",
      },
      {
        name: "goal lookup",
        usage: "[--agent <name> | --session <id>]",
        desc: "Show agent goal",
      },
    ],
  },
  {
    heading: "Debug",
    entries: [
      {
        name: "inspect",
        usage: "--worker <name> [--name <leader>]",
        desc: "Inspect worker session transcript",
        cont: ["[--room <name>] [--turns N]"],
      },
      {
        name: "interrupt",
        usage: "--worker <name> --room <name> [--name <name>]",
        desc: "Interrupt worker",
      },
      {
        name: "clear",
        usage: "--worker <name> --room <name> [--name <name>]",
        desc: "Clear worker session",
      },
      {
        name: "compact",
        usage: "--worker <name> --room <name> [message] [--name <name>]",
        desc: "Compact worker context (send /compact)",
      },
      {
        name: "reassign",
        usage: "--worker <name> --room <name> --text <t> [--name <name>]",
        desc: "Replace current assignment",
      },
    ],
  },
  {
    heading: "Utility",
    entries: [
      { name: "refresh", usage: "[--name <name>]", desc: "Re-register agent" },
      {
        name: "wait-idle",
        usage: "--target <pane> [--timeout <ms>]",
        desc: "Wait until pane is idle",
        cont: ["[--stable-count N] [--idle-seconds N]"],
      },
    ],
  },
];

const INDENT = 2;
const NAME_WIDTH = 14; // fixed width for the command name column (including 1-space gap)
const DESC_COL = 44; // column where descriptions start

export function formatHelp(): string {
  const lines: string[] = [];
  lines.push("crew - multi-agent coordination CLI");
  lines.push("");
  lines.push("Usage: crew <command> [flags]");
  lines.push("");

  for (const group of HELP_GROUPS) {
    lines.push(group.heading);
    for (const e of group.entries) {
      const pad = " ".repeat(INDENT);

      if (!e.usage) {
        // Command with no flags: name then description
        const nameField = e.name.padEnd(DESC_COL - INDENT);
        lines.push(`${pad}${nameField}${e.desc}`);
      } else {
        // First line: name + usage
        const nameField = e.name.padEnd(NAME_WIDTH - INDENT);
        const firstLine = `${pad}${nameField}${e.usage}`;

        if (firstLine.length + 2 <= DESC_COL) {
          // Fits on one line with room for description
          const gap = " ".repeat(DESC_COL - firstLine.length);
          lines.push(`${firstLine}${gap}${e.desc}`);
        } else {
          // Usage is long: description goes on next line
          lines.push(firstLine);
          lines.push(`${" ".repeat(DESC_COL)}${e.desc}`);
        }
      }

      // Continuation lines align at DESC_COL
      if (e.cont) {
        const contPad = " ".repeat(DESC_COL);
        for (const c of e.cont) {
          lines.push(`${contPad}${c}`);
        }
      }
    }
    lines.push("");
  }

  lines.push("Flags:");
  lines.push(
    `${" ".repeat(INDENT)}--json      Output raw JSON instead of text`,
  );
  lines.push(`${" ".repeat(INDENT)}--help      Show this help message`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Result formatters (unchanged)
// ---------------------------------------------------------------------------

const formatInputBlock = (d: any) => {
  let out = `${d.name} input-block:${d.input_block_mode}`;
  if (d.flushed_messages !== undefined && d.flushed_messages > 0) {
    out += ` flushed:${d.flushed_messages} msgs`;
  }
  return out;
};

const FORMATTERS: Record<string, (data: any) => string> = {
  check: (d) =>
    Object.entries(d.scopes)
      .map(
        ([k, v]: [string, any]) =>
          `${k}:${typeof v === "object" ? v.version : v}`,
      )
      .join(" "),

  status: (d) => {
    if (d.inline) return d.inline;
    if (d.dashboard) return d.dashboard;
    const pane = d.tmux_target ? ` pane:${d.tmux_target}` : " pane:(none)";
    return `${d.name} ${d.status}${pane} ${d.room_name ?? d.room ?? ""}${d.room_path ? ` (${d.room_path})` : ""}`;
  },

  rooms: (d) => {
    if (!d.rooms?.length) return "(no rooms)";
    return d.rooms
      .map(
        (r: any) =>
          `[ID: ${r.id}] ${r.name} (${r.path}) ${r.member_count} members (${r.roles.leader}l ${r.roles.worker}w)`,
      )
      .join("\n");
  },

  members: (d) => {
    const header = d.topic ? `[${d.room}] ${d.topic}\n` : `[${d.room}]\n`;
    return (
      header +
      d.members
        .map(
          (m: any) =>
            `  ${m.name} ${m.role} ${m.status} pane:${m.tmux_target ?? "(none)"} input-block:${m.input_block_mode ?? "off"}${m.ctx_pct != null ? ` context-window:${m.ctx_pct}%${m.ctx_pct >= 80 ? " ⚠ compact/clear encouraged" : ""}` : ""}`,
        )
        .join("\n")
    );
  },

  read: (d) => {
    if (!d.messages?.length) return "(no messages)";
    return d.messages
      .map((m: any) => {
        const to = m.to ? `→${m.to}` : "";
        const kind = m.kind !== "chat" ? `(${m.kind})` : "";
        return `[${m.from}@${m.room}${to}]${kind}: ${m.text}`;
      })
      .join("\n");
  },

  send: (d) => {
    let base = "";
    if (d.broadcast) {
      base = `broadcast to ${d.recipients} (${d.delivered} delivered)`;
    } else {
      base = `msg:${d.message_id} ${d.delivered ? "delivered" : "queued"}`;
    }

    if (d.members && d.members.length > 0) {
      const membersStr = d.members
        .map(
          (m: any) =>
            `  ${m.name} ${m.role} ${m.status} pane:${m.tmux_target ?? "(none)"} input-block:${m.input_block_mode ?? "off"}`,
        )
        .join("\n");
      return `${base}\nMembers:\n${membersStr}`;
    }
    return base;
  },

  "send-batch": (d) => {
    const workers = d.workers
      .map((w: any) => `  ${w.name}: ${w.dispatch_status}`)
      .join("\n");
    return `batch:${d.batch_id}\n${workers}`;
  },

  join: (d) =>
    `Joined ${d.room} (ID: ${d.room_id}) as ${d.name} (${d.role}) pane:${d.tmux_target}`,
  "input-block": formatInputBlock,
  ib: formatInputBlock,
  block: formatInputBlock,
  unblock: formatInputBlock,
  leave: () => "Left room",
  refresh: (d) =>
    `Refreshed ${d.name} room:${d.room ?? d.room_name ?? ""} (ID: ${d.room_id ?? ""}) pane:${d.tmux_target}`,
  topic: (d) => `Topic set: ${d.topic}`,
  interrupt: () => "Interrupted worker",
  inspect: (d) => {
    const lines = [
      `worker: ${d.agent_name}`,
      `room: ${d.room_name}`,
      `provider: ${d.provider}`,
      `session_id: ${d.session_id ?? "null"}`,
      `status: ${d.status}`,
      `updated_at: ${d.updated_at ?? "null"}`,
      `block_hint: ${d.block_hint}`,
      `source: ${d.source}`,
    ];
    if (d.degraded) {
      lines.push(`degraded: true`);
      lines.push(`degradation_reason: ${d.degradation_reason}`);
    }
    if (Array.isArray(d.turns) && d.turns.length > 0) {
      lines.push("");
      for (const turn of d.turns) {
        lines.push(`[${turn.role}] ${turn.text}`);
      }
    }
    return lines.join("\n");
  },
  clear: (d) => `Cleared ${d.worker_name} session`,
  compact: (d) => `Compacted ${d.worker_name} context`,
  reassign: () => "Sent replacement assignment",
  "create-room": (d) =>
    `Created room: ${d.room}${d.topic ? ` (${d.topic})` : ""}`,
  "delete-room": (d) =>
    `Deleted room: ${d.room} (${d.removed_members.length} members removed, ${d.messages_deleted} messages deleted)`,
  "mute-idle": (d) =>
    `${d.name} idle notifications ${d.idle_muted ? "muted" : "unmuted"}. ${d.note ?? ""}`,
  "unmute-idle": (d) =>
    `${d.name} idle notifications ${d.idle_muted ? "muted" : "unmuted"}. ${d.note ?? ""}`,
  mute: (d) =>
    `${d.name} idle notifications ${d.idle_muted ? "muted" : "unmuted"}. ${d.note ?? ""}`,
  unmute: (d) =>
    `${d.name} idle notifications ${d.idle_muted ? "muted" : "unmuted"}. ${d.note ?? ""}`,
  "pause-polling": (d) =>
    `polling paused=${d.paused} mode=${d.busy_mode}${d.reason ? ` reason:${d.reason}` : ""}`,
  "resume-polling": (d) => `polling paused=${d.paused} mode=${d.busy_mode}`,
  "polling-status": (d) =>
    `polling paused=${d.paused} mode=${d.busy_mode}${d.reason ? ` reason:${d.reason}` : ""}`,
  "set-polling-busy": (d) =>
    `polling busy_mode=${d.busy_mode} paused=${d.paused}`,
  polling: (d) =>
    `polling paused=${d.paused} mode=${d.busy_mode}${d.reason ? ` reason:${d.reason}` : ""}`,
  hint: (d) => {
    if (d.error) return `Error: ${d.error}`;
    if (d.hint?.status) return d.hint.status;
    if (d.hint?.message) return d.hint.message;
    if (d.message) return d.message;
    if (d.hint?.agent_name) return `Registered agent: ${d.hint.agent_name}`;
    return "";
  },
  goal: (d) => {
    if (d.error) return `Error: ${d.error}`;
    if (d.goal_status)
      return `Goal ${d.goal_status}${d.message ? ` — ${d.message}` : ""}`;
    if (d.removed) return d.message ?? "Goal removed";
    if (d.goal)
      return `🎯 ${d.goal.agent_name}: "${d.goal.description}" (${d.goal.status}, turn ${d.goal.turn_count ?? 0})`;
    return "(no goal)";
  },
  "hook-event": (d) => {
    // Hook stdout is injected into Claude Code conversations.
    // Emit hint text only when cadence fires; otherwise stay silent.
    if (d.hint?.message) return d.hint.message;
    return "";
  },
  party: (d) => {
    if (d.started) {
      return `Started party round ${d.round} on topic: "${d.topic}"\nWorkers: ${d.workers.join(", ")}`;
    }
    if (d.ended) {
      return `Ended party. Completed ${d.rounds_completed} rounds`;
    }
    if (d.round && d.topic) {
      return `Advanced to round ${d.round} on topic: "${d.topic}"\nWorkers: ${d.workers.join(", ")}`;
    }
    if (d.skipped) {
      return `Skipped worker: ${d.skipped}\nPending: ${d.pending.join(", ")}`;
    }
    if (d.active) {
      return `Party round ${d.round} on topic: "${d.topic}"\nResponded: ${d.responded.join(", ")}\nPending: ${d.pending.join(", ")}`;
    }
    return JSON.stringify(d);
  },
  "create-task": (d) => `Created task ${d.task.id} for ${d.task.assigned_to}`,
  "update-task": (d) => `Updated task ${d.task.id} (${d.task.status})`,
  "get-task-details": (d) => `Task ${d.task.id}: ${d.task.summary}`,
};
