# crew

A plugin for AI coding agents that turns your terminal into an AI development team. Multiple agents work in parallel, coordinated through tmux rooms. Works with **Claude Code** and **OpenAI Codex CLI**.

## How it works

1. Start AI coding agent sessions in tmux panes
2. Register each agent into a room: `/crew:join-room myproject --role worker --name builder-1`
3. Your own session is the boss — give natural language direction
4. Leaders coordinate workers, workers execute tasks, everyone communicates through rooms
5. Task tracking with lifecycle statuses — leaders can interrupt or reassign worker tasks
6. Task context sharing — workers record findings in task notes for handoff, leaders search prior work to avoid repeating investigations
7. Dashboard visualization — three views (Tab to switch): dashboard (original), task board (grouped by agent/room), timeline (waterfall chart)
8. Automatic token/cost tracking — collects usage from Claude Code and Codex CLI, displays in dashboard
9. Worker session management — leaders can clear a worker's Claude Code context and auto-refresh their registration between task sequences
10. Automatic dead agent cleanup — periodic liveness check every 30 seconds detects disconnected workers and cleans up their tasks + registration

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
| `update_task` | Worker: update task status (queued/active/completed/error) — now accepts `context` for handoff notes |
| `interrupt_worker` | Leader/Boss: send Escape to worker pane, mark task interrupted |
| `reassign_task` | Leader/Boss: replace worker's current/queued task with a new one |
| `clear_worker_session` | Leader/Boss: send `/clear` to worker (clears Claude Code context), auto-refresh registration |
| `get_task_details` | Get full details of a task including worker context notes |
| `search_tasks` | Search completed tasks by room, agent, keyword, or status — find relevant context from previous work |
| `check_changes` | Return version numbers for `messages`, `tasks`, `agents` scopes — call before `get_status`/`read_messages` to skip polls when nothing changed (~90% cost reduction during quiet periods) |

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

Read-only terminal observer built with React+Ink. Shows rooms, agents with roles and live status, message feed, task tracking, and cost analytics in a 3-panel layout.

```
┌─ Rooms & Agents ───────────┐┌─ Messages ─────────────────────────┐
│ ▼ company (2)              ││ 14:32:01 [TASK] boss → lead-1      │
│   ● boss (boss)    idle    ││   Build the auth system            │
│   ● lead-1 (leader) busy   ││ 14:33:00 [DONE] builder-1 → lead-1 │
│ ▼ frontend (3)             │├─ Details ──────────────────────────┤
│   ◦ lead-1 (leader) busy   ││ lead-1  leader | busy              │
│   ● builder-1 (worker) idle││ Rooms: company, frontend           │
└────────────────────────────┘│ Cost: $12.50 | Tokens: 245k       │
  Cost: $12.50 (245k tok)    └────────────────────────────────────┘
```

**Header:** Summary of agent status (busy/idle/dead), task progress, errors, uptime, and **total crew cost + token count**.

**Tree panel:** agents show `● name (role) $cost` with status color. Secondary agents (in multiple rooms) show dim `◦`. Rooms collapse with `▶`/`▼`. Per-agent cost updated every 30s from collected token usage.

**Details panel:** agent view shows live tmux pane output and cost/token stats; room view shows task summary (open tasks / completed / errors from message kinds).

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

## Token & Cost Tracking

Crew automatically collects token usage from Claude Code and Codex CLI agents:

- **Collection**: 30-second interval, per agent
- **Sources**: Claude Code JSONL logs (`~/.claude/projects/`) + Codex SQLite DB (`~/.codex/state_5.sqlite`)
- **Agent detection**: Auto-detected on `join_room` (claude-code, codex, or unknown)
- **Display**: Total crew cost in header, per-agent cost in tree panel, detailed cost/token stats in details panel
- **Pricing**: Configurable per-model — uses published Claude/OpenAI rates by default

The `pricing` table stores input/output cost per million tokens. Update costs anytime:

```bash
sqlite3 /tmp/crew/state/crew.db "INSERT INTO pricing (model_name, input_cost_per_million, output_cost_per_million) VALUES ('claude-opus-4-6', 15.0, 75.0) ON CONFLICT DO UPDATE SET input_cost_per_million=15.0, output_cost_per_million=75.0;"
```

## State Management

State is stored in a SQLite database at `${CREW_STATE_DIR}/crew.db` (default `/tmp/crew/state/crew.db`) using WAL mode for safe multi-process access. All state operations are synchronous — no flush/sync machinery needed.

```bash
# Debug: inspect state directly
sqlite3 /tmp/crew/state/crew.db 'SELECT * FROM agents;'
sqlite3 /tmp/crew/state/crew.db 'SELECT * FROM messages ORDER BY id DESC LIMIT 10;'
sqlite3 /tmp/crew/state/crew.db 'SELECT agent_name, cost_usd, model FROM token_usage ORDER BY recorded_at DESC LIMIT 5;'
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
