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
  /** Roles allowed to run this command. Hidden only from a confirmed `worker`;
   *  `leader`/`user` (unregistered) always see the full reference. */
  allowedRoles?: Array<"leader" | "worker" | "user">;
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
        allowedRoles: ["leader"],
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
        cont: [
          "[--to <agent>] [--name <self>] [--reply-to <id>] [--sender-pane <pane>]",
        ],
      },
      {
        name: "send-batch",
        usage: "--room <name> --manifest <path> --name <name>",
        desc: "Send batch messages to workers",
        allowedRoles: ["leader"],
      },
      {
        name: "read",
        usage: "[--name <name>] [--room <name>] [--limit N]",
        desc: "Consume queued messages (advances cursor)",
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
        allowedRoles: ["leader"],
      },
      {
        name: "unmute idle",
        usage: "[--name <name>]",
        desc: "Unmute idle notifications",
        allowedRoles: ["leader"],
      },
      {
        name: "auto-self",
        usage: "on|off [--name <leader>]",
        desc: "Toggle auto --self on leader idle",
        allowedRoles: ["leader"],
      },
    ],
  },
  {
    heading: "Party",
    entries: [
      {
        name: "party start",
        usage: "--room <name> --topic <t> --name <leader>",
        desc: "Start a round-gated worker discussion",
        allowedRoles: ["leader"],
      },
      {
        name: "party next",
        usage: "--room <name> --topic <t> --name <leader>",
        desc: "Advance to next round (digests prev)",
        allowedRoles: ["leader"],
      },
      {
        name: "party end",
        usage: "--room <name> --name <leader>",
        desc: "End the active party",
        allowedRoles: ["leader"],
      },
      {
        name: "party skip",
        usage: "--room <name> --worker <w> --name <leader>",
        desc: "Skip a worker for this round",
        allowedRoles: ["leader"],
      },
      {
        name: "party status",
        usage: "[--room <name> | --name <agent>]",
        desc: "Show round, responses & pending",
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
        name: "goal",
        usage: "[--room <name>]",
        desc: "Show all goals in a room (overview)",
      },
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
      {
        name: "goal history",
        usage: "[--agent <name> --room <name>]",
        desc: "List past goals (with ids to reuse)",
      },
      {
        name: "goal redo",
        usage: "<id> [--room <name>]",
        desc: "Reactivate a past goal by id",
      },
      {
        name: "dialog pending",
        usage: "[--room <name>]",
        desc: "List pending worker dialogs",
      },
      {
        name: "dialog answer",
        usage: "<worker> --pick N[,M] [--room <name>]",
        desc: "Drive worker AskUserQuestion",
        allowedRoles: ["leader"],
      },
      {
        name: "dialog approve",
        usage: "<worker> [--room <name>]",
        desc: "Approve worker plan (Enter)",
        allowedRoles: ["leader"],
      },
    ],
  },
  {
    heading: "Worker Control",
    entries: [
      {
        name: "inspect",
        usage: "--worker <name> [--name <leader>]",
        desc: "Inspect worker session transcript",
        cont: ["[--room <name>] [--turns N]"],
        allowedRoles: ["leader"],
      },
      {
        name: "interrupt",
        usage: "--worker <name> --room <name> [--name <name>]",
        desc: "Interrupt worker",
        allowedRoles: ["leader"],
      },
      {
        name: "clear",
        usage: "--worker <name> --room <name> [--name <name>]",
        desc: "Clear worker session",
        allowedRoles: ["leader"],
      },
      {
        name: "compact",
        usage: "--worker <name> --room <name> [message] [--name <name>]",
        desc: "Compact worker context (send /compact)",
        allowedRoles: ["leader"],
      },
      {
        name: "reassign",
        usage: "--worker <name> --room <name> --text <t> [--name <name>]",
        desc: "Replace current assignment",
        allowedRoles: ["leader"],
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

/**
 * Visibility rule:
 *  - open entries (no allowedRoles): visible to everyone
 *  - role-restricted entries: hidden ONLY from a confirmed `worker`
 *
 * `user` (unregistered — e.g. exploring in a shell, or a leader in a fresh
 * pane) sees the full reference so `crew help` is a complete discovery
 * surface. Runtime role checks still gate the commands themselves, so a
 * worker who glimpses a command cannot actually misuse it.
 */
function isEntryVisible(
  entry: HelpEntry,
  role: "leader" | "worker" | "user",
): boolean {
  // return true;
  if (!entry.allowedRoles || entry.allowedRoles.length === 0) return true;
  if (role !== "worker") return true;
  return entry.allowedRoles.includes(role);
}

export function formatHelp(
  role: "leader" | "worker" | "user" = "user",
): string {
  const lines: string[] = [];
  lines.push("crew - multi-agent coordination CLI");
  lines.push("");
  lines.push("Usage: crew <command> [flags]");
  lines.push(`Scope: ${role}`);
  lines.push("");

  for (const group of HELP_GROUPS) {
    const entries = group.entries.filter((entry) =>
      isEntryVisible(entry, role),
    );
    if (entries.length === 0) continue;

    lines.push(group.heading);
    for (const e of entries) {
      const pad = " ".repeat(INDENT);

      if (!e.usage) {
        // Command with no flags: name then description
        const nameField = e.name.padEnd(DESC_COL - INDENT);
        lines.push(`${pad}${nameField}${e.desc}`);
      } else {
        // First line: name + usage. Pad to the column, or to name+1
        // (whichever larger) so a long name keeps a separating space
        // before the usage flags (e.g. "polling busy <auto|...>").
        const nameField = e.name.padEnd(
          Math.max(NAME_WIDTH - INDENT, e.name.length + 1),
        );
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
        return `[${m.from}@${m.room}${to}]: ${m.text}`;
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
    // Room overview (`crew goal` with no subcommand)
    if (d.overview) {
      if (!d.goals || d.goals.length === 0)
        return `No goals set in room "${d.room}".`;
      const lines = [`Goals in room "${d.room}":`];
      for (const g of d.goals) {
        const mark = g.status === "active" ? "🎯" : "  ";
        lines.push(
          `${mark} ${g.agent_name}: "${g.description}" (${g.status}, turn ${g.turn_count ?? 0})`,
        );
      }
      return lines.join("\n");
    }
    // History list (`crew goal history`)
    if (d.history) {
      if (!d.goals || d.goals.length === 0)
        return `No goal history in room "${d.room}"${d.agent ? ` for ${d.agent}` : ""}.`;
      const lines = [
        `Goal history in room "${d.room}"${d.agent ? ` · ${d.agent}` : ""}:`,
      ];
      for (const g of d.goals) {
        lines.push(
          `  [${g.id}] ${g.agent_name}: "${g.description}" (${g.status}, turn ${g.turn_count ?? 0})`,
        );
      }
      return lines.join("\n");
    }
    if (d.goal)
      return `🎯 ${d.goal.agent_name}: "${d.goal.description}" (${d.goal.status}, turn ${d.goal.turn_count ?? 0})${d.redone_from ? ` — redone from #${d.redone_from}` : ""}`;

    return "(no goal)";
  },
  dialog: (d) => {
    if (d.error) return `Error: ${d.error}`;
    if (Array.isArray(d.dialogs)) {
      if (d.dialogs.length === 0) return `(no pending dialogs in ${d.room})`;
      return d.dialogs
        .map((dg: any) => {
          const head = `#${dg.id} ${dg.worker} [${dg.type}]${dg.header ? ` ${dg.header}` : ""}`;
          const step =
            dg.total_questions && dg.total_questions > 1
              ? ` (${dg.question_index + 1}/${dg.total_questions})`
              : "";
          const q = dg.question ? `    ${dg.question}${step}` : "";
          const opts = (dg.options ?? [])
            .map((o: any) => `    [${o.n}] ${o.label}`)
            .join("\n");
          const cmd =
            dg.type === "plan_approval"
              ? `    → crew dialog approve ${dg.worker}`
              : dg.multi_select
                ? `    → crew dialog answer ${dg.worker} --pick ${dg.options.map((o: any) => o.n).join(",")}`
                : `    → crew dialog answer ${dg.worker} --pick N`;
          return [head, q, opts, cmd].filter(Boolean).join("\n");
        })
        .join("\n\n");
    }
    if (d.approved)
      return `Approved plan for ${d.worker} (dialog #${d.dialog_id})`;
    if (Array.isArray(d.picks))
      return `Answered ${d.worker} (dialog #${d.dialog_id}): picks [${d.picks.join(",")}] keys: ${d.keys ?? ""}`;
    return JSON.stringify(d);
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
