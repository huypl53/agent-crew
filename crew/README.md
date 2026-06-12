# crew

Multi-agent coordination for AI coding agents via tmux rooms. Works with **Claude Code** and **OpenAI Codex CLI**.

**GitHub:** [https://github.com/huypl53/agent-crew](https://github.com/huypl53/agent-crew)

## How it works

1. Start AI coding agent sessions in tmux panes
2. Register each agent into a room: `/crew:join-room myproject --role worker --name builder-1`
3. Your own session acts as a leader — give natural language direction
4. Leaders coordinate workers, workers execute assignments, everyone communicates through rooms
5. Assignment delivery via pushed messages — leaders can interrupt or replace worker assignments
6. **Interactive management TUI** — `crew manage` gives leaders a zero-dependency terminal UI to select rooms and members, then apply actions (interrupt, clear session, reassign task, set topic, leave, delete) on one or many targets at once
7. Worker session management — leaders can clear a worker's Claude Code context and auto-refresh their registration between assignment sequences
8. Automatic dead agent cleanup — periodic liveness check every ~30s detects disconnected workers and cleans up their registration (debounced, leaders are never removed)
9. Role-aware delivery — every push message includes a role reminder suffix so agents remember their responsibilities
10. Leader idle notification control — leaders can mute/unmute sweep idle notifications from workers
11. Auto-self on idle — leaders automatically see `crew status --self` dashboard when going idle (toggleable per-leader)
12. Polling flow control — pause/resume sweep delivery to leaders, or switch between auto/manual busy detection

## Architecture

- **Leaders** (including your session) → manage workers in project rooms
- **Workers** → execute assignments, report status

Communication: push messages (tmux paste-buffer with bracketed paste, role-aware suffix on content) + pull messages (server-side queue for status updates).

## Requirements

- tmux 3.0+
- Bun runtime
- Claude Code **or** OpenAI Codex CLI

## Installation

### Quick Install

```bash
git clone https://github.com/huypl53/agent-crew.git ~/.crew
cd ~/.crew/crew && bun install

# Install CLI globally
cd ~/.crew/crew && bun link

# Install plugin (skills only — behavioral guidance for agents)
claude plugins marketplace add ~/.crew
claude plugins install crew@crew-plugins

# Verify — all 5 skills should appear
claude --print "list skills" | grep crew
```

The plugin provides behavioral skills (`/crew:join-room`, `/crew:refresh`, `leader`, `worker`). The CLI (`crew`) provides the actual commands that skills invoke.

### Local Development

```bash
cd ~/.crew/crew && bun link
```

`bun link` creates a global `crew` symlink pointing to your local source — code changes are instantly available without reinstalling.

### Manual Install — Codex CLI

```bash
git clone https://github.com/huypl53/agent-crew.git ~/.crew
cd ~/.crew/crew && bun install && bun link

# Personal Codex plugin root (created by the installer if missing)
mkdir -p ~/.codex/plugins ~/.agents/plugins

# Expose the plugin at a stable local path
ln -sfn ~/.crew/crew ~/.codex/plugins/crew

# Register a local marketplace for Codex
cat > ~/.agents/plugins/marketplace.json <<'JSON'
{
  "name": "local-crew-plugins",
  "interface": { "displayName": "Local Crew Plugins" },
  "plugins": [
    {
      "name": "crew",
      "source": {
        "source": "local",
        "path": "./.codex/plugins/crew"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
JSON

# Register marketplace root (once)
codex marketplace add ~
```

Then install the plugin in Codex (required):

1. Start `codex`
2. Run `/plugins`
3. Open marketplace `Local Crew Plugins`
4. Select `Crew` and choose `Install plugin`
5. Start a new thread (or restart Codex)

Skills: `crew:join-room`, `crew:leader`, `crew:worker`, `crew:refresh`.

#### Codex Sandbox Configuration (macOS)

Codex's default sandbox blocks access to tmux sockets, preventing crew from delivering messages or detecting agent status. Add these settings to `~/.codex/config.toml`:

```toml
sandbox_mode = "danger-full-access"
approval_policy = "never"
```

Without this configuration, agents will show as "dead" and messages will remain queued instead of delivered.

### Manual Install — Antigravity CLI

You can install the plugin natively for the **Antigravity CLI** (`agy`) in either **global** or **project** scope:

#### Global Scope
```bash
# Install globally for all projects:
./install.sh --agy
```

This automates:
1. Cloning the repository to `~/.crew` and linking the `crew` command.
2. Creating the plugin directory `~/.gemini/config/plugins/huypl53.crew`.
3. Symlinking `plugin.json`, `hooks.json`, and the `skills/` directory.

#### Project Scope
```bash
# Install locally for the current project:
./install.sh --agy-project [optional_path_to_project_root]
```

This automates:
1. Linking skills into `.agents/skills/` in the project root.
2. Appending/merging event hooks into `.agents/hooks.json` in the project root.

To check if the skills are correctly registered in Antigravity:
```bash
agy --print "list skills" | grep crew
```

### Uninstall

```bash
cd ~/.crew/crew && bun unlink
claude plugins uninstall crew@crew-plugins

# Optional Codex cleanup
rm -f ~/.codex/plugins/crew
# Then remove "crew" from ~/.agents/plugins/marketplace.json
# And remove [plugins."crew@local-crew-plugins"] from ~/.codex/config.toml

# Optional Antigravity cleanup (global)
./install.sh --uninstall-agy

# Optional Antigravity cleanup (project scope)
./install.sh --uninstall-agy-project [optional_path_to_project_root]
```


## Usage

```bash
# Run tests
bun test --cwd ~/.crew/crew

# End-to-end test with live tmux panes
```

## CLI

The `crew` CLI is the primary interface for agents. Agents call `crew send ...` via Bash, with **50-80% lower token overhead** than MCP (no 17-schema transmission per turn).

After `bun link`, the `crew` binary is available globally:

```bash
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
| `read` | `crew read --name wk-01 --room crew` | `[leader@crew→wk-01](task): do the thing` |
| `status` | `crew status wk-01` or `crew status --self` or `crew status --session <id>` | `wk-01 idle %33 crew (/path/to/project)` or rich dashboard with `--self` |
| `check` | `crew check --name wk-01` | `messages:42 agents:8` |
| `refresh` | `crew refresh --name wk-01` | `Refreshed wk-01 rooms:crew pane:%42` |
| `topic` | `crew topic --room crew --text "Sprint 3" --name lead-01` | `Topic set: Sprint 3` |
| `interrupt` | `crew interrupt --worker wk-01 --room crew --name lead-01` | `Interrupted worker` |
| `clear` | `crew clear --worker wk-01 --room crew --name lead-01` | `Cleared wk-01 session` (sends `/clear` + `/rename` to reset context and session name) |
| `reassign` | `crew reassign --worker wk-01 --room crew --text "new task" --name lead-01` | `Sent replacement assignment` |
| `pause-polling` | `crew pause-polling --reason "leader sync"` | `polling paused=true mode=auto reason:leader sync` |
| `resume-polling` | `crew resume-polling` | `polling paused=false mode=auto` |
| `polling-status` | `crew polling-status` | `polling paused=false mode=auto` |
| `set-polling-busy` | `crew set-polling-busy --mode manual_busy` | `polling busy_mode=manual_busy paused=false` |
| `mute-idle` | `crew mute-idle --name lead-01` | `lead-01 idle notifications muted` |
| `unmute-idle` | `crew unmute-idle --name lead-01` | `lead-01 idle notifications unmuted` |
| `auto-self` | `crew auto-self on --name lead-01` or `crew auto-self off --name lead-01` | `lead-01 auto-self-on-idle:on` / `off` |
| `create-room` | `crew create-room --room proj --name lead-01 --topic "Sprint 1"` | `Created room: proj (Sprint 1)` |
| `delete-room` | `crew delete-room --room proj --confirm --name lead-01` | `Deleted room: proj (3 members removed, 12 messages deleted)` |
| `manage` | `crew manage --name lead-01` | Interactive TUI — pick rooms/members and apply actions |
| `wait-idle` | `crew wait-idle --target %42 --timeout 30000` | exit 0 = idle, exit 2 = timed out |
| `party start` | `crew party start --room crew --topic "..." --name lead-01` | `{"started":true,"round":1,...}` |
| `party next` | `crew party next --room crew --topic "..." --name lead-01` | `{"round":2,...}` |
| `party end` | `crew party end --room crew --name lead-01` | `{"ended":true,"rounds_completed":2}` |
| `party skip` | `crew party skip --room crew --worker wk-01 --name lead-01` | `{"skipped":"wk-01","pending":[...]}` |
| `party status` | `crew party status --room crew` | `{"active":true,"round":1,"topic":"...","responded":[...],"pending":[...]}` |
| `hint set` | `crew hint set "You are builder-1 in project-x." -c 3` | `Hint set for builder-1 in crew. Will inject your message every 3 turn(s).` |
| `hint unset` | `crew hint unset --agent builder-1 --room crew` | `Hint removed for builder-1 in crew` |
| `hint lookup` | `crew hint lookup --pane %42` | `agent_name: builder-1, cadence: 3, next_reminder_at: 2` |
| `goal set` | `crew goal set "Implement auth module" --agent wk-01 --room crew` | `🎯 wk-01: "Implement auth module" (active, turn 0)` |
| `goal done` | `crew goal done --agent wk-01 --room crew` | `Goal done — completed for wk-01 in crew` |
| `goal update` | `crew goal update "Fix bug in auth.ts" --agent wk-01 --room crew` | `🎯 wk-01: "Fix bug in auth.ts" (active, turn 0)` |
| `goal unset` | `crew goal unset --agent wk-01 --room crew` | `Goal removed for wk-01 in crew` |
| `goal lookup` | `crew goal lookup --agent wk-01 --room crew` or `crew goal lookup --session <id>` | `🎯 wk-01: "Implement auth module" (active, turn 3)` |

### Interactive Management TUI (`crew manage`)

`crew manage --name <your-leader-name>` opens a zero-dependency terminal UI (uses Node's built-in `readline` — no extra packages needed) for leaders to inspect and control their rooms interactively.

**Flow:**
```
 crew manage --name lead-01

  ? Select a room to manage
  ❯ my-project (/path/to/project)
    other-room  (/path/to/other)

  ↓ Enter

  ? my-project - Select action
  ❯ Manage members (Single)   ← pick one worker → apply an action
    Manage members (Bulk)     ← multi-select workers → apply action to all
    Set room topic
    Leave room
    Delete room
    Back

  ↓ Select "Manage members (Single)"

  ? Select a worker to manage
  ❯ builder-1 (worker) - status: busy
    builder-2 (worker) - status: idle
    Back

  ↓ Enter on builder-1

  ? Worker: builder-1 - Select action
  ❯ Interrupt Worker
    Clear Session
    Reassign Task
    Back
```

**Controls:**

| Key | Action |
|-----|--------|
| `↑` / `↓` or `k` / `j` | Move highlight |
| `Space` | Toggle selection (Bulk mode) |
| `Enter` | Confirm / apply |
| `Escape` or `q` | Back / exit |
| `Ctrl-C` | Quit immediately |

**Bulk mode** lets you select multiple workers with `Space` and apply one action (Interrupt, Clear, or Reassign) to all of them in a single step.

**Access control:** only rooms the caller belongs to are shown; only workers inside the selected room are listed.

### Flags

- `--json` — output raw JSON instead of compact text (machine-readable)
- `--help` — show usage

### send flags

| Flag | Description |
|------|-------------|
| `--room` | Room to send in (required) |
| `--text` | Inline message text (mutually exclusive with `--file`) |
| `--file` | Read exact UTF-8 message body from file (mutually exclusive with `--text`) |
| `--name` | Your agent name / sender (required) |
| `--to` | Target agent (omit for broadcast) |
| `--kind` | `task`, `completion`, `question`, `error`, `status`, `chat` (default: `chat`) |
| `--mode` | `push` (tmux delivery) or `pull` (queue only, default: `push`) |

For long task briefs, prefer `--file` over shell substitution:

```bash
crew send --room crew --to wk-01 --file /tmp/task.txt --name lead-01 --kind task
```

`--file` reads the file as UTF-8 text, preserves newlines exactly, and rejects invalid UTF-8, empty files, or oversized payloads.

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
# Returns: messages:42 agents:8
crew check --name wk-01

# If versions haven't changed, skip read_messages/get_status entirely
```

### Delivery & Sweep System

**Push delivery** uses tmux `paste-buffer -dp` (bracketed paste) with two item types:

| Queue Item | Behavior |
|------------|----------|
| `paste` | Content delivery — includes role-aware suffix (e.g. `--- Remember: You are a worker.`) |
| `command` | CLI commands (`/rename`, `/clear`) — sent raw, no suffix appended |

**Sweep** runs every 5 seconds and performs two checks:

1. **Idle detection** — detects workers with unchanged tmux pane content for 60+ seconds, notifies leaders (can be muted per-leader with `mute-idle`)
2. **Liveness validation** — every ~30s checks all agents' tmux pane processes. Dead workers are removed after 2 consecutive failures (debounced). Leaders are never removed.

**Polling flow control** lets leaders manage sweep delivery timing:

```bash
# Pause all sweep deliveries (manual override)
crew pause-polling --reason "syncing with leader"

# Auto mode: defer delivery when leader pane appears busy (default)
crew set-polling-busy --mode auto

# Manual busy: always defer
crew set-polling-busy --mode manual_busy

# Manual free: always deliver immediately
crew set-polling-busy --mode manual_free

# Resume and flush deferred queue
crew resume-polling
```

## MCP Tools (Legacy)

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
| `interrupt_worker` | Leader: send Escape to worker pane and notify the worker |
| `reassign_task` | Leader: interrupt and send a replacement assignment |
| `clear_worker_session` | Leader: send `/clear` + `/rename` to worker (clears Claude Code context), auto-refresh registration |
| `check_changes` | Return version numbers for `messages` and `agents` scopes — call before `get_status`/`read_messages` to skip polls when nothing changed (~90% cost reduction during quiet periods) |
| `create_room` | Create a new room with optional topic |
| `delete_room` | Delete a room and remove all members + messages (requires `--confirm`) |
| `mute_idle` | Leader: mute sweep idle notifications from workers |
| `unmute_idle` | Leader: unmute sweep idle notifications |

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
| `leader` | Leader behavior — coordinate workers, assign work |
| `worker` | Worker behavior — execute assignments, report status |
| `party` | Party mode — round-gated multi-worker discussions |

## Registered-Agent Hints

Custom context reminders injected into the agent's conversation on a configurable cadence. Useful for keeping agents aware of their role, project context, or specific instructions across long sessions.

```bash
# Set a hint with a custom message (required) and cadence (default: every 3 turns)
crew hint set "You are builder-1 in project-x. Check inbox before responding." -c 1

# Set with auto-detection from current tmux pane
crew hint set "Remember: follow the coding standards in /docs/style.md"

# Set for a specific agent/room explicitly
crew hint set --agent builder-1 --room myproject "You own the auth module. Only touch files in src/auth/."

# Look up current hint state (read-only, does not advance cadence)
crew hint lookup --pane %42

# Remove a hint
crew hint unset --agent builder-1 --room myproject
```

The message is a positional argument after `set` — no flag needed. Use quotes for multi-word messages.

**`-c N`** (default 3) — how often the hint fires. `-c 1` fires every turn, `-c 5` fires on the 5th, 10th, 15th, etc.

**Identity precedence:** The hook handler looks up hints by `session_id` first, falling back to `TMUX_PANE` bootstrap. When Claude Code first emits a `session_id`, the pane-bound hint is migrated to the session — survives tmux reattach, won't leak to a new session on the same pane.

## Self Status Dashboard

`crew status --self` shows a rich dashboard for the current agent (auto-detected from `TMUX_PANE`), including:

- Agent name, role, status, and room
- Active hint (if registered) with next reminder cadence
- Pending unread messages (with `--json` for structured count by kind)
- Worker summary (leaders only: how many workers busy/idle/dead)
- Last activity timestamp

```bash
# Show your dashboard
crew status --self

# JSON output for scripting
crew status --self --json
```

## Auto-Self on Idle

Leaders automatically receive `crew status --self` when they transition from busy→idle, so they immediately see their dashboard after completing a task. This is on by default.

```bash
# Check current setting (default: on)
crew auto-self on --name lead-01

# Disable auto-self on idle
crew auto-self off --name lead-01

# Re-enable
crew auto-self on --name lead-01
```

The toggle is per-leader agent. When `auto_self_on_idle` is off, the busy→idle transition still fires normally but no `crew status --self` command is sent.

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
.claude-plugin/
  marketplace.json    # Marketplace config (points to crew/)
crew/                 # Crew plugin
  .claude-plugin/
    plugin.json       # Plugin manifest
  src/
    cli.ts            # CLI entrypoint (#!/usr/bin/env bun)
    cli/              # CLI modules
    tools/            # Tool handlers
    ...
  commands/           # 2 slash commands — /crew:{join-room,refresh}
  skills/             # agent skills — leader, worker (model-invoked after join)
  test/               # Test suite
  ...
```
