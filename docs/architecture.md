# cc-tmux Architecture

## Overview

cc-tmux is a Claude Code MCP server plugin + TUI dashboard. Agents register into rooms with roles (boss/leader/worker) and communicate via tmux.

## Data Flow

```
Agent calls MCP tool
  → src/index.ts routes to tool handler in src/tools/
  → tool calls src/state/ for data operations
  → if send_message: tool calls src/delivery/
    → delivery calls state.addMessage() (always, writes to roomMessages + inbox)
    → delivery calls tmux.sendKeys() (push mode only)
    → if kind ∈ {completion, error, question} and sender is worker:
        delivery calls tmux.sendKeys() for each leader (auto-notify)
  → tool returns MCP JSON response

Dashboard reads /tmp/cc-tmux/state/*.json via fs.watch
  → polls tmux capture-pane every 2s for status
  → renders 3-panel ANSI layout to stdout
```

## Module Boundaries

- **src/tools/** — One handler per MCP tool. Imports from state/tmux/delivery. Never calls another tool.
- **src/state/** — Owns all data. In-memory primary, JSON flush to `/tmp/cc-tmux/state/`. No other module reads/writes files.
- **src/tmux/** — Pure tmux CLI wrapper via Bun.spawn(). No business logic. Strips ANSI from capture-pane output.
- **src/delivery/** — Push (tmux send-keys) + pull (queue). Always queues first, then delivers.
- **src/shared/** — Types, status regex patterns. Used by both MCP server and dashboard.
- **src/dashboard/** — TUI modules. Reads state files (read-only), polls tmux, renders ANSI.
- **skills/** — Pure markdown. No code execution.

## Dependency Graph (acyclic)

```
tools → {state, delivery, tmux}
delivery → {state, tmux}
dashboard → {shared, tmux (for polling)}
state → tmux (for liveness validation)
```

## Room Conversation Log

Room is the canonical message store (v2 model):

- `roomMessages: Map<room, Message[]>` — all messages in a room, in order, capped at 1000
- `inboxes: Map<agent, Message[]>` — kept for backward compat (legacy `read_messages` without room param)
- `cursors: Map<agent, Map<room, sequence>>` — per-agent read position per room

### Message Kind

Every message has an explicit `kind` field:

| Kind | Sender | Meaning |
|------|--------|---------|
| `task` | leader | Work assignment to a worker |
| `completion` | worker | Task finished successfully |
| `error` | worker | Task failed or blocked |
| `question` | worker | Needs clarification |
| `status` | any | Progress update |
| `chat` | any | General communication (default) |

### Auto-Notification Routing

When a worker sends `kind ∈ {completion, error, question}`, delivery automatically pushes a brief summary to all leaders in the room:

```
[system@frontend]: builder-1 completion: "Login component done"
```

This is a tmux push only (no inbox entry). Leaders receive the notification in their pane without polling.

### Cursor-Based Room Reads

`readRoomMessages(agentName, room, kinds?, limit?)`:
1. Gets cursor position for agent+room (0 if never read)
2. Filters room log for messages with `sequence > cursor`
3. Optionally filters by `kinds` array
4. Advances cursor to max sequence seen
5. Returns `{ messages, next_sequence }`

Calling `read_messages` with `room` param uses this path. Calling without `room` falls back to legacy inbox.

## Key Patterns

- **Naming:** snake_case for MCP (tools, params, JSON), camelCase for TS, kebab-case for files
- **Messages:** Written to room log first, then inbox (backward compat), then push delivery
- **Push format:** `[sender@room]: text` via `tmux send-keys -l`
- **Auto-notify format:** `[system@room]: worker kind: "summary"` via `tmux send-keys -l`
- **Status detection:** On-demand `capture-pane` + strip-ansi + regex match (idle/busy/dead/unknown)
- **State persistence:** Write-through JSON flush after every mutation (agents, rooms, messages, room-messages)
- **Error handling:** Tool handlers never throw — return `{ error: "..." }` with `isError: true`
- **Terminal safety:** Dashboard registers cleanup on SIGINT/SIGTERM/uncaughtException

## CC Status Line Regexes (from UAT)

| State | Pattern | Example |
|-------|---------|---------|
| Idle | `^❯\s*$` | Empty prompt |
| Busy | `/^[·*✶✽✻]\s+\w+…\s+\(\d/` | `· Contemplating… (3s)` |
| Complete | `/^✻\s+\w+\s+for\s+/` | `✻ Baked for 1m 2s` |
| Dead | `tmux list-panes #{pane_dead}` | Pane doesn't exist |

## Dashboard Panel Layout

```
Left (30%): Room/agent tree with collapse, status colors, multi-room badges
Right-top (70% x 65%): Chronological message feed, color-coded rooms
Right-bottom (70% x 35%): Selected agent details
```

## Installation Architecture

```
curl|sh (GitHub raw)
  → git clone to ~/.cc-tmux/
  → bun install
  → copy skills/ → ~/.claude/skills/cc-tmux-*/SKILL.md  (user scope)
  → merge MCP entry → ~/.claude.json mcpServers           (user scope)

install.sh --project (from any project dir)
  → copy skills/ → .claude/skills/cc-tmux-*/SKILL.md     (project scope)
  → merge MCP entry → .mcp.json mcpServers                (project scope)
```

- User scope: `~/.claude.json` for MCP, `~/.claude/skills/` for skills — available everywhere
- Project scope: `.mcp.json` + `.claude/skills/` — committed to repo for team sharing
- MCP server path is always absolute: `~/.cc-tmux/src/index.ts`
- JSON merging uses python3 (available on macOS + Linux) — preserves existing entries
- No `.claude-plugin/` or `--plugin-dir` needed — direct config approach

## UAT Insights

### Push message format in tmux panes
`[sender@room]: text` is delivered via `tmux send-keys -l` + Enter. Zsh shells show `no matches found` because brackets are glob chars — irrelevant in real CC usage since CC reads stdin directly.

### Multi-process state sharing
Each CC session spawns its own MCP server subprocess (via stdio transport). They share state through `/tmp/cc-tmux/state/*.json` files using a **read-merge-write** pattern:

- `flushAsync()` reads existing disk state, merges with in-memory, then writes. This prevents processes from clobbering each other's data.
- `syncFromDisk()` is called before every read operation (list_rooms, list_members, send_message, read_messages, get_status) to pick up state changes from other processes.
- Room membership uses set-union during merge — members from all processes are combined.
- Messages are deduplicated by `message_id` during merge.

This was discovered and fixed during UAT when 3 simultaneous CC processes were overwriting each other's agent registrations.

### Status detection scope
CC-specific regexes (idle/busy/complete) only match the CC status line. A plain shell prompt returns "unknown" — correct behavior. Dead detection uses `tmux list-panes #{pane_dead}`, which returns true for non-existent panes.

### Dashboard raw mode navigation
The TUI dashboard runs in raw stdin mode (alternate screen). Navigation requires raw escape sequences (`\x1b[A`/`\x1b[B`), not tmux named keys like `Down`. The `q` key exits cleanly to the normal terminal.

### Test architecture
- **Unit tests**: Mock tmux via test helpers, test state/tools/patterns/dashboard rendering in isolation
- **UAT tests**: Call real tool handlers against real tmux panes, verify push delivery via `capturePane`, state persistence via file reads, auto-notify via pane capture
- **Dashboard UAT**: Visual verification by tmux agent — launch, capture, navigate, quit
