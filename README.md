# cc-tmux

A plugin for AI coding agents that turns your terminal into an AI development team. Multiple agents work in parallel, coordinated through tmux rooms. Works with **Claude Code** and **OpenAI Codex CLI**.

## How it works

1. Start AI coding agent sessions in tmux panes
2. Register each agent into a room: `/crew:join-room myproject --role worker --name builder-1`
3. Your own session is the boss — give natural language direction
4. Leaders coordinate workers, workers execute tasks, everyone communicates through rooms

## Architecture

- **Boss** (your session) → manages leaders in the company room
- **Leaders** → manage workers in project rooms
- **Workers** → execute tasks, report status

Communication: push messages (tmux send-keys for commands) + pull messages (server-side queue for status updates).

## Requirements

- tmux 3.0+
- Bun runtime
- Claude Code **or** OpenAI Codex CLI

## Installation

### Claude Code

**One-line install** (user scope — available in all sessions):

```bash
curl -fsSL https://raw.githubusercontent.com/OWNER/cc-tmux/main/install.sh | sh
```

This clones cc-tmux to `~/.cc-tmux/`, installs dependencies, adds skills to `~/.claude/skills/`, and registers the MCP server in `~/.claude.json`.

**Per-project install** (committed to repo so teammates get it):

```bash
~/.cc-tmux/install.sh --project
```

Copies skills to `.claude/skills/` and creates `.mcp.json` in the current project.

**Update / Uninstall:**

```bash
~/.cc-tmux/install.sh --update             # pull latest + re-copy skills
~/.cc-tmux/install.sh --uninstall          # remove global install
~/.cc-tmux/install.sh --uninstall-project  # remove from current project
```

### OpenAI Codex CLI

**Option 1: Local plugin (recommended for development)**

Clone the repo and add it to your personal marketplace:

```bash
git clone https://github.com/OWNER/cc-tmux.git ~/.cc-tmux
cd ~/.cc-tmux && bun install
```

Create `~/.agents/plugins/marketplace.json`:

```json
{
  "name": "local-plugins",
  "interface": { "displayName": "Local Plugins" },
  "plugins": [
    {
      "name": "crew",
      "source": { "source": "local", "path": "~/.cc-tmux" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

Then install via `/plugins` in Codex CLI.

**Option 2: MCP server only (no skills)**

Add the MCP server directly in `~/.codex/config.toml`:

```toml
[mcp_servers.cc-tmux]
command = "bun"
args = ["run", "~/.cc-tmux/src/index.ts"]
```

## Usage

```bash
# TUI dashboard (separate terminal/pane)
bun run --cwd ~/.cc-tmux dashboard

# Run tests
bun test --cwd ~/.cc-tmux
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `join_room` | Register in a room with role + name |
| `leave_room` | Leave a room |
| `list_rooms` | List active rooms |
| `list_members` | List room members (includes topic) |
| `send_message` | Send push/pull message with optional `kind` |
| `read_messages` | Read room log or inbox with optional `kinds` filter |
| `get_status` | Check agent status |
| `set_room_topic` | Set current objective for a room |

### `send_message` params

| Param | Type | Description |
|-------|------|-------------|
| `room` | string | Room to send in |
| `text` | string | Message text |
| `name` | string | Your agent name (sender) |
| `to` | string? | Target agent (omit for broadcast) |
| `mode` | push\|pull | push = tmux delivery, pull = queue only (default: push) |
| `kind` | task\|completion\|question\|error\|status\|chat | Message kind (default: chat) |

Workers sending `completion`, `error`, or `question` automatically trigger a push notification to all leaders in the room.

### `read_messages` params

| Param | Type | Description |
|-------|------|-------------|
| `name` | string | Your agent name |
| `room` | string? | Room to read — uses room log + cursor when provided |
| `kinds` | string[]? | Filter by kind (e.g. `["completion", "error"]`) |
| `limit` | number? | Max messages (default 50) |
| `since_sequence` | number? | Legacy inbox cursor (only when `room` omitted) |

When `room` is provided, reads the full room conversation log (all members' messages) from your last-read position. Each call advances your cursor automatically.

## Skills

Bundled in `skills/` for both Claude Code and Codex CLI. Invoke with `/crew:<skill>`:

| Skill | Invoke | Description |
|-------|--------|-------------|
| `join-room` | `/crew:join-room` | Register your agent in a room with a role |
| `refresh` | `/crew:refresh` | Re-register after session resume |
| `boss` | `/crew:boss` | Boss management patterns |
| `leader` | `/crew:leader` | Leader coordination patterns |
| `worker` | `/crew:worker` | Worker task handling patterns |

## TUI Dashboard

Read-only terminal observer built with React+Ink. Shows rooms, agents with roles and live status, message feed, and context-sensitive details in a 3-panel layout.

```
┌─ Rooms & Agents ──────────┐┌─ Messages ─────────────────────────┐
│ ▼ company (2)              ││ 14:32:01 [TASK] boss → lead-1      │
│   ● boss (boss)    idle    ││   Build the auth system             │
│   ● lead-1 (leader) busy   ││ 14:33:00 [DONE] builder-1 → lead-1 │
│ ▼ frontend (3)             │├─ Details ────────────────────────────┤
│   ◦ lead-1 (leader) busy   ││ lead-1  leader | busy               │
│   ● builder-1 (worker) idle││ Rooms: company, frontend            │
└────────────────────────────┘│ Working on auth component...        │
                               └─────────────────────────────────────┘
```

**Tree panel:** agents show `● name (role)` with status color. Secondary agents (in multiple rooms) show dim `◦`. Rooms collapse with `▶`/`▼`.

**Details panel:** agent view shows live tmux pane output; room view shows task summary (open tasks / completed / errors from message kinds).

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `↑` / `k` | Move up |
| `↓` / `j` | Move down |
| `gg` | Jump to top |
| `G` | Jump to bottom |
| `Enter` / `Space` | Collapse/expand room |
| `?` | Toggle help overlay |
| `q` / `Ctrl-C` | Quit |

Shortcuts are always visible in the bottom status bar.

## State Management

State is stored in a SQLite database at `${CC_TMUX_STATE_DIR}/cc-tmux.db` (default `/tmp/cc-tmux/state/cc-tmux.db`) using WAL mode for safe multi-process access. All state operations are synchronous — no flush/sync machinery needed.

```bash
# Debug: inspect state directly
sqlite3 /tmp/cc-tmux/state/cc-tmux.db 'SELECT * FROM agents;'
sqlite3 /tmp/cc-tmux/state/cc-tmux.db 'SELECT * FROM messages ORDER BY id DESC LIMIT 10;'
```

## Project Structure

```
src/
├── index.ts          # MCP server entrypoint
├── tools/            # 8 MCP tool handlers
├── tmux/             # tmux CLI wrapper
├── state/            # SQLite state (db.ts = schema, index.ts = queries)
├── delivery/         # Push (tmux) + pull (queue) delivery
├── shared/           # Types, status patterns (shared with dashboard)
├── dashboard.ts      # Dashboard entrypoint
└── dashboard/        # React+Ink TUI dashboard
    ├── components/   #   Pure Ink components (TreePanel, MessageFeedPanel, DetailsPanel, ...)
    └── hooks/        #   Data hooks (useStateReader, useTree, useFeed, useStatus)
skills/               # 5 bundled skills — /crew:{join-room,refresh,boss,leader,worker}
.codex-plugin/        # Codex CLI plugin manifest
.mcp.json             # MCP server config (shared by Claude Code + Codex)
test/                 # Test suite
```
