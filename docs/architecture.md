# cc-tmux Architecture

## Overview

cc-tmux is a Claude Code MCP server plugin + TUI dashboard. Agents register into rooms with roles (boss/leader/worker) and communicate via tmux.

## Data Flow

```
Agent calls MCP tool
  → src/index.ts routes to tool handler in src/tools/
  → tool calls src/state/ for data operations (synchronous SQLite queries)
  → if send_message: tool calls src/delivery/
    → delivery calls state.addMessage() (always, writes to messages table)
    → delivery calls tmux.sendKeys() (push mode only)
    → if kind ∈ {completion, error, question} and sender is worker:
        delivery calls tmux.sendKeys() for each leader (auto-notify)
  → tool returns MCP JSON response

Dashboard is a React+Ink app (separate process)
  → useStateReader polls PRAGMA data_version every 500ms (detects ALL DB changes)
  → useStateReader polls tmux capture-pane every 2s for status + pane output
  → useTree/useFeed/useStatus consume state and expose derived data to components
  → Ink renders component tree: App > Layout > TreePanel + MessageFeedPanel + DetailsPanel + StatusBar + HelpOverlay
```

## Module Boundaries

- **src/tools/** — One handler per MCP tool. Imports from state/tmux/delivery. Never calls another tool.
- **src/state/db.ts** — Database singleton: `initDb()`, `getDb()`, `closeDb()`. Owns schema DDL.
- **src/state/index.ts** — All state operations as synchronous SQLite queries. No in-memory caching.
- **src/tmux/** — Pure tmux CLI wrapper via Bun.spawn(). No business logic. Strips ANSI from capture-pane output.
- **src/delivery/** — Push (tmux send-keys) + pull (queue). Always queues first, then delivers.
- **src/shared/** — Types, status regex patterns. Used by both MCP server and dashboard.
- **src/dashboard/** — React+Ink TUI. Hooks (`useStateReader`, `useTree`, `useFeed`, `useStatus`) consume SQLite (read-only) + tmux. Components are pure renderers.
- **skills/** — Pure markdown. No code execution.

## Dependency Graph (acyclic)

```
tools → {state, delivery, tmux}
delivery → {state, tmux}
state/index → {state/db, tmux}
dashboard → {shared, tmux (for polling), bun:sqlite (readonly), ink, react}
```

## State Management — SQLite

State is stored in `${CC_TMUX_STATE_DIR}/cc-tmux.db` (default `/tmp/cc-tmux/state/cc-tmux.db`).

### Why SQLite (not JSON files)

The original architecture used 4 JSON files (`agents.json`, `rooms.json`, `messages.json`, `room-messages.json`) with an in-memory primary store and async read-merge-write flush pattern. This had three problems:

1. **Cross-process races** — Multiple MCP server processes (one per CC session) could flush concurrently, causing data loss even with per-process flush locks
2. **Write amplification** — Every mutation rewrote all 4 files
3. **Merge complexity** — ~200 lines of dedup-by-message-id, set-union membership, generation counters, and ESM import hoisting workarounds

SQLite via `bun:sqlite` eliminates all three: WAL mode handles concurrent access, writes are row-level, and every operation is a simple SQL query.

### Schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

agents   (name PK, role, pane, registered_at, last_activity)
rooms    (name PK, topic, created_at)
members  (room FK, agent FK, joined_at) — junction table
messages (id AUTOINCREMENT, sender, room, recipient, text, kind, mode, timestamp)
cursors  (agent, room, last_seq) — per-agent read position

idx_messages_room      ON messages(room, id)
idx_messages_recipient ON messages(recipient, id)
```

### Key Properties

- **WAL mode** — Multiple processes read concurrently, SQLite serializes writes atomically
- **Synchronous API** — All state operations are sync (no flushAsync/syncFromDisk)
- **Immediate consistency** — No stale in-memory cache; every read hits the DB
- **Autoincrement ID** — Replaces both `message_id` and `sequence` fields
- **Cursors persist** — Survive MCP server restarts (stored in `cursors` table)

### Debugging

```bash
sqlite3 /tmp/cc-tmux/state/cc-tmux.db '.tables'
sqlite3 /tmp/cc-tmux/state/cc-tmux.db 'SELECT * FROM agents;'
sqlite3 /tmp/cc-tmux/state/cc-tmux.db 'SELECT * FROM messages ORDER BY id DESC LIMIT 10;'
```

## Room Conversation Log

Room is the canonical message store:

- All messages are stored in the `messages` table with a `room` column
- Cursors in `cursors` table track per-agent read position per room
- No separate inbox storage — `readMessages` queries by `recipient` column

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

This is a tmux push only (no DB entry). Leaders receive the notification in their pane without polling.

### Cursor-Based Room Reads

`readRoomMessages(agentName, room, kinds?, limit?)`:
1. Gets cursor position for agent+room (0 if never read)
2. Queries messages table for `room = ? AND id > cursor`
3. Optionally filters by `kinds` array
4. Advances cursor to max id seen
5. Returns `{ messages, next_sequence }`

Calling `read_messages` with `room` param uses this path. Calling without `room` queries by `recipient` column.

## Resource Management

### Cursor Cleanup

Agent read cursors are cleaned up when an agent departs:
- `removeAgent(name, room)` — deletes cursors if agent has no remaining rooms
- `removeAgentFully(name)` — deletes all cursors for agent

### Foreign Key Cascades

`members` table has `ON DELETE CASCADE` for both `rooms(name)` and `agents(name)`. When an agent is deleted, all memberships are removed. Empty rooms are cleaned up explicitly after membership deletion.

## Key Patterns

- **Naming:** snake_case for MCP (tools, params, JSON), camelCase for TS, kebab-case for files
- **Messages:** Written to messages table, then push delivery if mode=push
- **Broadcast:** One message per recipient with `recipient` set to each target's name
- **Push format:** `[sender@room]: text` via `tmux send-keys -l`
- **Auto-notify format:** `[system@room]: worker kind: "summary"` via `tmux send-keys -l`
- **Status detection:** On-demand `capture-pane` + strip-ansi + regex match (idle/busy/dead/unknown)
- **Error handling:** Tool handlers never throw — return `{ error: "..." }` with `isError: true`
- **Terminal safety:** Dashboard registers cleanup on SIGINT/SIGTERM/uncaughtException
- **Test isolation:** Tests use `initDb(':memory:')` — no temp directories needed

## CC Status Line Regexes (from UAT)

| State | Pattern | Example |
|-------|---------|---------|
| Idle | `^❯\s*$` | Empty prompt |
| Busy | `/^[·*✶✽✻]\s+\w+…\s+\(\d/` | `· Contemplating… (3s)` |
| Complete | `/^✻\s+\w+\s+for\s+/` | `✻ Baked for 1m 2s` |
| Dead | `tmux list-panes #{pane_dead}` | Pane doesn't exist |

## Dashboard Architecture (Ink)

The dashboard is a React+Ink application using **ink 6.8.0**, **react 19**, and **@inkjs/ui**. Components are pure renderers; all business logic lives in hooks.

### Component Tree

```
App
└── Layout (flexDirection="row")
    ├── TreePanel          (width=30%, left column)
    ├── Box (width=70%, flexDirection="column")
    │   ├── MessageFeedPanel  (flexGrow=2)
    │   └── DetailsPanel      (flexGrow=1)
    └── StatusBar          (bottom row, full width)
        └── HelpOverlay    (rendered when ? pressed)
```

### Hook Data Flow

```
useStateReader (polls every 500ms)
  ├── reads DB: agents, rooms, messages tables
  ├── reads tmux: capture-pane every 2s for status + rawOutput
  └── feeds raw state to:
      ├── useTree(agents, rooms, statuses) → { nodes, selectedIndex, selectedNode, moveUp/Down/... }
      ├── useFeed(messages, rooms) → { formattedMessages }
      └── useStatus(agents) → { statuses: Map<name, AgentStatusEntry> }
```

### Panel Layout

```
Left (30%): Room/agent tree — agents appear under ALL rooms (dim + ◦ for secondary)
Right-top (70% x 65%): Chronological message feed, color-coded by room
Right-bottom (70% x 35%): Agent details or room task summary
Bottom row: StatusBar — ↑↓/jk:Navigate  Enter:Toggle  ?:Help  q:Quit  [!]=errors
```

### TreePanel — Role Display

Each agent row shows: `{dot} {name} ({role})`  
- `●` (colored by status) for primary agents, `◦` (dim gray) for secondary (agent appears in multiple rooms)
- Status colors: green=idle, yellow=busy, red=dead, gray=unknown
- Scroll windowing: `height - 2` visible lines, `▲ more` / `▼ more` hints

### Tree Selection Tracking

Selection tracks by node ID (`agent:name` or `agent:name:room` for secondary), not numeric index. This survives tree rebuilds when agents join/leave/reorder. Manual navigation disables auto-select (which otherwise follows the most-recently-active agent).

### DetailsPanel — Context-Sensitive Content

| Selection | Content |
|-----------|---------|
| Agent selected | name (bold), status + role + pane, rooms list, last activity, live pane output (rawOutput tail) |
| Room selected | room name, topic, member count, **Task Summary** (open/done/error counts from message kinds) |
| Nothing / syncing | "Syncing…" placeholder |

Task Summary counts are derived from the `messages` table: `task` kind = open assignments, `completion` = done, `error` = failed.

### AgentStatusEntry

```ts
interface AgentStatusEntry {
  status: 'idle' | 'busy' | 'dead' | 'unknown';
  lastChange: number;   // timestamp for auto-select sorting
  rawOutput?: string;   // full capture-pane text
}
```

### Performance: string-width Cache Patch

Ink internally uses `string-width` to measure text for Yoga layout. `string-width` calls `Intl.Segmenter` for any non-ASCII character — and Bun's `Intl.Segmenter` is **~500x slower** than the ASCII fast path (1.9ms vs 0.004ms per call). Box-drawing border characters (`─`, `│`, `┌`) alone cost 2.4ms per line. With 40+ text nodes per frame, this caused **440ms render times** — making navigation visibly laggy.

**Fix:** A module-level `Map` cache is patched into `node_modules/string-width/index.js` so each unique string only triggers `Intl.Segmenter` once. A `postinstall` script (`scripts/patch-string-width.sh`) reapplies the patch after `bun install`.

**Result:** Render time dropped from 440ms → 15ms (29x improvement). Rapid j/k navigation batches into 3 renders at 9-20ms each — within the 16.7ms budget at 60fps.

Other render optimizations applied:
- `incrementalRendering: true` + `maxFps: 60` — Ink diffs output and only writes changed cells
- Fixed layout dimensions (pre-computed from terminal size) instead of Yoga percentage widths
- `buildTree` decoupled from `statuses` — tree structure only rebuilds when agents/rooms change, not on every status poll
- Parallel agent polling via `Promise.all` instead of sequential subprocess spawning
- `React.memo` on all panel components; `useMemo` for rawOutput processing and derived state

### Error Logging

Dashboard errors go to `/tmp/cc-tmux/dashboard.log` (not console, which would corrupt the TUI). A `[!]` indicator appears in the StatusBar when errors exist.

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

## Multi-process Architecture

Each CC session spawns its own MCP server subprocess (via stdio transport). All share a single SQLite database file with WAL mode:

- Writes are serialized by SQLite's internal locking (`busy_timeout = 5000ms`)
- Reads never block — WAL allows concurrent readers
- The dashboard opens the DB in readonly mode and polls for changes
- No manual merge, flush, or lock code needed

## Test Architecture

- **Unit tests** (`test/state.test.ts`): Use `:memory:` SQLite DB, test state operations in isolation
- **Tool tests** (`test/tools.test.ts`): Use `:memory:` DB + real tmux sessions, test MCP tool handlers end-to-end
- **Dashboard hook tests** (`test/dashboard-hooks.test.ts`): Unit tests for `buildTree` pure function (ID-based selection, multi-room agents, unassigned section, collapse)
- **Dashboard component tests** (`test/dashboard-ink.test.tsx`): Ink component tests via `ink-testing-library` — TreePanel, MessageFeedPanel, DetailsPanel, StatusBar, HelpOverlay
