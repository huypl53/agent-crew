# cc-tmux

A Claude Code plugin that turns your terminal into an AI development team. Multiple Claude Code agents work in parallel, coordinated through tmux rooms.

## How it works

1. Start Claude Code sessions in tmux panes (as you normally would)
2. Register each agent into a room: `/cc-tmux:join-room myproject --role worker --name builder-1`
3. Your own CC session is the boss — give natural language direction
4. Leaders coordinate workers, workers execute tasks, everyone communicates through rooms

## Architecture

- **Boss** (your session) → manages leaders in the company room
- **Leaders** → manage workers in project rooms
- **Workers** → execute tasks, report status

Communication: push messages (tmux send-keys for commands) + pull messages (server-side queue for status updates).

## Requirements

- tmux 3.0+
- Bun runtime
- Claude Code

## Installation

**One-line install** (user scope — available in all CC sessions):

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

- `/cc-tmux:join-room` — Register your agent
- `/cc-tmux:leader` — Leader coordination patterns
- `/cc-tmux:worker` — Worker task handling patterns
- `/cc-tmux:boss` — Boss management patterns

## TUI Dashboard

Read-only terminal observer. Shows rooms, agents, status, and messages in a 3-panel layout.

```
┌─ Rooms & Agents ──────────┐┌─ Messages ─────────────────────────┐
│ ▼ company (2)              ││ 14:32:01 [boss@company] → lead-1   │
│   ● boss        idle       ││   Build the auth system             │
│   ● lead-1      busy       ││                                     │
│ ▼ frontend (3)             │├─ Details ────────────────────────────┤
│   ● lead-1 [+company] busy ││ Selected: lead-1                     │
│   ● builder-1   idle       ││ Role: leader | Rooms: company, front │
└────────────────────────────┘└─────────────────────────────────────┘
```

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `↑` / `k` | Move up |
| `↓` / `j` | Move down |
| `Enter` / `Space` | Collapse/expand room |
| `q` / `Ctrl-C` | Quit |

## Project Structure

```
src/
├── index.ts          # MCP server entrypoint
├── tools/            # 8 MCP tool handlers
├── tmux/             # tmux CLI wrapper
├── state/            # In-memory state + JSON persistence
├── delivery/         # Push (tmux) + pull (queue) delivery
├── shared/           # Types, status patterns (shared with dashboard)
├── dashboard.ts      # Dashboard entrypoint
└── dashboard/        # TUI dashboard modules
skills/               # 4 role-based skills
test/                 # Test suite
```
