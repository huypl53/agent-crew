# crew

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

Communication: push messages (tmux paste-buffer with bracketed paste for commands) + pull messages (server-side queue for status updates).

## Requirements

- tmux 3.0+
- Bun runtime
- Claude Code **or** OpenAI Codex CLI

## Installation

### Quick Install

```bash
git clone https://github.com/huypl53/agent-crew.git ~/.crew
cd ~/.crew

# Claude Code
./install.sh

# Codex CLI
./install.sh --codex

# Both platforms
./install.sh --all
```

The installer handles plugin registration, MCP server setup, and (for Codex) tool approval configuration automatically.

### Manual Install — Claude Code

```bash
git clone https://github.com/huypl53/agent-crew.git ~/.crew
cd ~/.crew && bun install

claude plugins marketplace add ~/.crew
claude plugins install crew@crew-plugins

# Verify — all 5 skills should appear
claude --print "list skills" | grep crew
```

Skills: `/crew:boss`, `/crew:join-room`, `/crew:leader`, `/crew:worker`, `/crew:refresh`.

### Manual Install — Codex CLI

```bash
git clone https://github.com/huypl53/agent-crew.git ~/.crew
cd ~/.crew && bun install

# MCP server
codex mcp add crew -- bun run ~/.crew/src/index.ts

# Plugin (skills)
ln -s ~/.crew ~/.codex/.tmp/plugins/plugins/crew

# Tool approvals for --full-auto mode (required per tool)
# The installer handles this automatically, or add manually to ~/.codex/config.toml:
# [mcp_servers.crew.tools.join_room]
# approval_mode = "approve"
# ... repeat for all 9 tools
```

Skills: `crew:boss`, `crew:join-room`, `crew:leader`, `crew:worker`, `crew:refresh`.

### Uninstall

```bash
./install.sh --uninstall          # Claude Code
./install.sh --uninstall-codex    # Codex CLI
./install.sh --uninstall-all      # Both
```

## Usage

```bash
# TUI dashboard (separate terminal/pane)
bun run --cwd ~/.crew dashboard

# Run tests
bun test --cwd ~/.crew

# End-to-end test with live tmux panes
bun ~/.crew/test/uat-sqlite.ts
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

## Commands & Skills

**Commands** (user-invoked via `/crew:<name>`):

| Command | Description |
|---------|-------------|
| `/crew:join-room` | Register your agent in a room with a role |
| `/crew:refresh` | Re-register after session resume |

**Skills** (auto-invoked by model after joining a room):

| Skill | Description |
|-------|-------------|
| `boss` | Boss behavior — manage leaders, strategic direction |
| `leader` | Leader behavior — coordinate workers, assign tasks |
| `worker` | Worker behavior — execute tasks, report status |

## TUI Dashboard

Read-only terminal observer built with React+Ink. Shows rooms, agents with roles and live status, message feed, and context-sensitive details in a 3-panel layout.

```
┌─ Rooms & Agents ───────────┐┌─ Messages ─────────────────────────┐
│ ▼ company (2)              ││ 14:32:01 [TASK] boss → lead-1      │
│   ● boss (boss)    idle    ││   Build the auth system            │
│   ● lead-1 (leader) busy   ││ 14:33:00 [DONE] builder-1 → lead-1 │
│ ▼ frontend (3)             │├─ Details ──────────────────────────┤
│   ◦ lead-1 (leader) busy   ││ lead-1  leader | busy              │
│   ● builder-1 (worker) idle││ Rooms: company, frontend           │
└────────────────────────────┘│ Working on auth component...       │
                              └────────────────────────────────────┘
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

State is stored in a SQLite database at `${CREW_STATE_DIR}/crew.db` (default `/tmp/crew/state/crew.db`) using WAL mode for safe multi-process access. All state operations are synchronous — no flush/sync machinery needed.

```bash
# Debug: inspect state directly
sqlite3 /tmp/crew/state/crew.db 'SELECT * FROM agents;'
sqlite3 /tmp/crew/state/crew.db 'SELECT * FROM messages ORDER BY id DESC LIMIT 10;'
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
commands/             # 2 slash commands — /crew:{join-room,refresh}
skills/               # 3 agent skills — boss, leader, worker (model-invoked after join)
.codex-plugin/        # Codex CLI plugin manifest
.mcp.json             # MCP server config (shared by Claude Code + Codex)
test/                 # Test suite
```
