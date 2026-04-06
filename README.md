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
| `list_members` | List room members |
| `send_message` | Send push/pull message |
| `read_messages` | Read inbox messages |
| `get_status` | Check agent status |

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

Controls: `↑`/`↓` navigate, `Enter`/`Space` collapse/expand, `q` quit.

## Project Structure

```
src/
├── index.ts          # MCP server entrypoint
├── tools/            # 7 MCP tool handlers
├── tmux/             # tmux CLI wrapper
├── state/            # In-memory state + JSON persistence
├── delivery/         # Push (tmux) + pull (queue) delivery
├── shared/           # Types, status patterns (shared with dashboard)
├── dashboard.ts      # Dashboard entrypoint
└── dashboard/        # TUI dashboard modules
skills/               # 4 role-based skills
test/                 # Test suite
```
