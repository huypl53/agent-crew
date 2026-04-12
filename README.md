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

## CLI (Alternative Interface)

The `crew` CLI binary provides the same functionality as MCP tools but via shell commands. Agents call `crew send ...` via Bash instead of `mcp__crew__send_message`, reducing token overhead by **50-80%** (no 17-schema transmission per turn).

### Installation

```bash
# Direct (no install needed)
bun /path/to/crew/src/cli.ts <command>

# As global binary
cd ~/.crew && bun link
crew <command>
```

### Quick Reference

| Command | Example | Output |
|---------|---------|--------|
| `join` | `crew join --room crew --role worker --name wk-01` | `Joined crew as wk-01 (worker) pane:%42` |
| `leave` | `crew leave --room crew --name wk-01` | `Left room` |
| `rooms` | `crew rooms` | `crew 5 members (1b 1l 3w)` |
| `members` | `crew members --room crew` | `[crew] topic\n  wk-01 worker idle` |
| `send` | `crew send --room crew --text "done" --name wk-01 --kind completion` | `msg:42 delivered` |
| `read` | `crew read --name wk-01 --room crew` | `[boss@crew→wk-01](task): do the thing` |
| `status` | `crew status wk-01` | `wk-01 idle %33 crew task:#5(active)` |
| `check` | `crew check --name wk-01` | `messages:42 tasks:15 agents:8` |
| `refresh` | `crew refresh --name wk-01` | `Refreshed wk-01 rooms:crew pane:%42` |
| `topic` | `crew topic --room crew --text "Sprint 3" --name lead-01` | `Topic set: Sprint 3` |
| `update-task` | `crew update-task --task 5 --status completed --name wk-01` | `task:#5 → completed` |
| `interrupt` | `crew interrupt --worker wk-01 --room crew --name lead-01` | `Interrupted task:#5 (was active)` |
| `clear` | `crew clear --worker wk-01 --room crew --name lead-01` | `Cleared wk-01 session` |
| `reassign` | `crew reassign --worker wk-01 --room crew --text "new task" --name lead-01` | `Reassigned: old:#5 → new:#6` |
| `task-details` | `crew task-details 5` | `#5 [completed] wk-01 — summary` |
| `search-tasks` | `crew search-tasks --room crew --status completed` | `#5 [completed] wk-01 — summary` |

### Flags

- `--json` — output raw JSON instead of compact text (machine-readable)
- `--help` — show usage

### send flags

| Flag | Description |
|------|-------------|
| `--room` | Room to send in (required) |
| `--text` | Message text (required) |
| `--name` | Your agent name / sender (required) |
| `--to` | Target agent (omit for broadcast) |
| `--kind` | `task`, `completion`, `question`, `error`, `status`, `chat` (default: `chat`) |
| `--mode` | `push` (tmux delivery) or `pull` (queue only, default: `push`) |

### read flags

| Flag | Description |
|------|-------------|
| `--name` | Your agent name (required) |
| `--room` | Room to read (uses room log + cursor) |
| `--kinds` | Comma-separated filter: `task,completion` |
| `--limit` | Max messages (default 50) |

### check — token-efficient polling

Call before expensive reads to skip polls when nothing changed:

```bash
# Returns: messages:42 tasks:15 agents:8
crew check --name wk-01

# If versions haven't changed, skip read_messages/get_status entirely
```

MCP tools remain available as a fallback for environments that don't support shell execution.

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
├── cli.ts            # CLI entrypoint (#!/usr/bin/env bun)
├── cli/              # CLI modules
│   ├── parse.ts      #   Arg parser: parseArgs(argv) → { command, positional, flags }
│   ├── router.ts     #   Dispatch table: 16 subcommands → tool handlers
│   └── formatter.ts  #   Plain text output formatters + --json flag
├── tools/            # 16 MCP tool handlers (shared by MCP + CLI)
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
