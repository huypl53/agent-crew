# Crew Architecture

## Overview

Crew is an MCP server plugin + TUI dashboard for AI coding agents (Claude Code, OpenAI Codex CLI). Agents register into rooms with roles (boss/leader/worker) and communicate via tmux.

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
- **src/tmux/** — Pure tmux CLI wrapper via Bun.spawn(). No business logic. Strips ANSI from capture-pane output. Uses `load-buffer` + `paste-buffer -dp` for message delivery (see "tmux Delivery" section below).
- **src/delivery/** — Push (tmux paste-buffer) + pull (queue). Always queues first, then delivers.
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

State is stored in `${CREW_STATE_DIR}/crew.db` (default `/tmp/crew/state/crew.db`).

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

### Schema Migrations

`CREATE TABLE IF NOT EXISTS` does NOT add new columns to existing tables. When new columns are added to the schema in `db.ts`, existing databases keep the old schema. Two mechanisms handle this:

1. **MCP server (read-write):** `initDb()` runs `ALTER TABLE ... ADD COLUMN` with try/catch after executing the schema DDL. This migrates the running DB when the MCP server starts.

2. **Dashboard (read-only):** `useStateReader.readAll()` uses fallback queries. If a query fails due to a missing column (e.g., `agent_type`), it retries with only the core columns that always exist. This prevents the dashboard from breaking on older DBs it can't migrate.

**Gotcha:** If the dashboard's `readAll()` query references a column that doesn't exist and there's no fallback, the query fails silently (caught by try/catch), returns empty results, and the tree shows rooms with member counts but no agent nodes underneath — mimicking a "collapsed" appearance. Always add a fallback query when selecting optional columns.

**Known migration columns:** `agents.agent_type` (added after initial schema).

### Dashboard Resilience Patterns

The dashboard opens the DB in read-only mode. Every table query in `readAll()` is wrapped in try/catch with an empty-array default. This means:

- Missing tables → empty data (dashboard renders but shows nothing)
- Missing columns → fallback query without that column
- DB doesn't exist → `readAll()` returns null → "Waiting for cc-tmux..." screen
- Once the MCP server creates/migrates tables, the next poll (500ms) picks up data automatically

**React state sync in useTree:** The `selectedIdRef` must be updated synchronously whenever `selectedId` changes (inside setState updaters and useEffect hooks). If only synced via useEffect (async, post-render), rapid keyboard input (navigate then Enter) reads stale ref values. Always assign `selectedIdRef.current = newId` in the same call that updates `setSelectedId`.

### Debugging

```bash
sqlite3 /tmp/crew/state/crew.db '.tables'
sqlite3 /tmp/crew/state/crew.db 'SELECT * FROM agents;'
sqlite3 /tmp/crew/state/crew.db 'SELECT * FROM messages ORDER BY id DESC LIMIT 10;'
# Check actual schema vs expected (missing columns = migration needed):
sqlite3 /tmp/crew/state/crew.db '.schema agents'
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

## Change Detection

The `check_changes` tool provides lightweight version polling to avoid expensive full-data reads.

### change_log Table

```sql
CREATE TABLE change_log (
  scope TEXT PRIMARY KEY,   -- 'messages', 'tasks', or 'agents'
  version INTEGER NOT NULL  -- monotonically incremented on each change
);
```

Three scopes track independent change streams:
- `messages` — bumped whenever a message is inserted
- `tasks` — bumped whenever a task is created, updated, or its event is recorded
- `agents` — bumped whenever an agent joins, leaves, or is cleaned up

### SQLite Triggers

Versions are auto-incremented by SQLite triggers on each table, requiring no application-level coordination:

```sql
CREATE TRIGGER bump_messages_version AFTER INSERT ON messages
  BEGIN UPDATE change_log SET version = version + 1 WHERE scope = 'messages'; END;

CREATE TRIGGER bump_tasks_version AFTER UPDATE ON tasks
  BEGIN UPDATE change_log SET version = version + 1 WHERE scope = 'tasks'; END;

-- Similar triggers for agents INSERT/DELETE
```

### check_changes Tool

Returns current version numbers for requested scopes:

```json
{
  "versions": {
    "messages": 42,
    "tasks": 7,
    "agents": 3
  }
}
```

### Check-Before-Poll Pattern

Leaders and bosses store the last-seen version per scope and only call expensive tools when a version changes:

```
1. versions = check_changes({ scopes: ['messages', 'tasks', 'agents'] })
2. if versions.agents != lastAgentsVersion:
     get_status(worker)          ← pane capture + status match
     lastAgentsVersion = versions.agents
3. if versions.messages != lastMessagesVersion:
     read_messages(room)         ← DB query + cursor advance
     lastMessagesVersion = versions.messages
4. sleep 5-10s, go to step 1
```

`check_changes` itself is a single-row SQLite read with no tmux interaction — negligible cost compared to `get_status` (which runs `tmux capture-pane`) or `read_messages` (which scans the messages table). During quiet periods (no activity), all versions stay constant and full-data polls are skipped entirely.

## Liveness Sweep

The MCP server runs a periodic liveness check every 30 seconds. When an agent's tmux pane is detected as dead, the server automatically:

1. Cleans up the agent's pending tasks (marks active/queued tasks as error with note "agent pane died")
2. Removes the agent from the agents table and all room memberships
3. Logs "Swept dead agent: <name>" to stderr

This prevents "ghost" agents from accumulating in the dashboard after disconnection. The sweep is triggered at server startup and then on a 30-second interval via `setInterval`.

## Server Stability & Crash Guards

The MCP server (`src/index.ts`) includes several mechanisms to survive long-running sessions on macOS:

**Root causes of shutdown (pre-fix):** SIGHUP from macOS when terminal sleeps, stdin EOF when parent disconnects, unhandled exceptions/rejections crashing the process.

**Crash guards:**
- `process.stdin.resume()` — prevents stdin EOF from exiting the process
- `SIGHUP` handler — graceful shutdown instead of crash (macOS sends this on terminal sleep)
- `uncaughtException` / `unhandledRejection` — logged but don't crash the server
- `SIGINT` / `SIGTERM` — clean interval teardown

**Server logging (`src/shared/server-log.ts`):**
- Writes to `$CREW_STATE_DIR/server.log` (default `/tmp/crew/state/server.log`)
- Auto-rotation: truncates to last 500 lines when file exceeds 1MB
- Levels: START, SWEEP, HEALTH, SIGNAL, WARN, ERROR, EXIT
- Never throws — all write errors are silently swallowed

**Health heartbeat (every 5 minutes):**
- Logs RSS, heap used/total, agent count, uptime
- Uses `process.memoryUsage()` and queries agents table

**Error logging added to:** tmux spawn/delivery (`src/tmux/index.ts`), token collection (`src/tokens/collector.ts`), pane capture (`src/tools/get-status.ts`), agent type detection (`src/tools/join-room.ts`)

## Key Patterns

- **Naming:** snake_case for MCP (tools, params, JSON), camelCase for TS, kebab-case for files
- **Messages:** Written to messages table, then push delivery if mode=push
- **Broadcast:** One message per recipient with `recipient` set to each target's name
- **Push format:** `[sender@room]: text` via `tmux paste-buffer -dp` (bracketed paste)
- **Auto-notify format:** `[system@room]: worker kind: "summary"` via `tmux paste-buffer -dp`
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
├── HeaderStats          (top row, full width — agent/task/error/uptime summary)
├── Layout (flexDirection="row")
│   ├── TreePanel          (width=30%, left column — error badges [N!], activity sparklines)
│   ├── Box (width=70%, flexDirection="column")
│   │   ├── MessageFeedPanel  (flexGrow=2 — kind filters 1-6, Q&A threading)
│   │   └── DetailsPanel      (flexGrow=1 — task tracker + agent stats + room overview)
│   └── StatusBar          (bottom row, full width)
│       └── HelpOverlay    (rendered when ? pressed)
```

### Hook Data Flow

```
useStateReader (polls every 500ms)
  ├── reads DB: agents, rooms, messages tables
  ├── reads tmux: capture-pane every 2s for status + rawOutput
  └── feeds raw state to:
      ├── useTree(agents, rooms, statuses) → { nodes, selectedIndex, selectedNode, moveUp/Down/... }
      ├── useFeed(messages, rooms) → { formattedMessages }
      ├── useStatus(agents) → { statuses: Map<name, AgentStatusEntry> }
      └── useTaskTracker(messages, room) → TrackedTask[] (matched task→completion/error pairs with duration)
```

### Panel Layout

```
Top row: HeaderStats — agent counts (busy/idle/dead), task progress (done/total), errors, uptime
         Compact mode (<100 cols): 4↑ 1○ 1✗ │ 12/15✓ 2✗ │ 1h23m
         Wide mode:   Agents: 4 busy  1 idle  1 dead │ Tasks: 12/15 done │ 2 errors │ Up: 1h 23m
Left (30%): Room/agent tree — agents under ALL rooms (dim + ◦ for secondary)
            Error badges: [N!] in red after agent name
            Activity sparklines: ▁▂▃▅▇▅▃▁▁▂ (10 buckets, 1min each, relative to agent max)
            Width-adaptive: hides role suffix/sparkline on narrow terminals
Right-top (70% x 65%): Chronological message feed, color-coded by room
            Kind filter toggles: 1=task, 2=done, 3=error, 4=question, 5=status, 6=chat
            Q&A threading: question→response pairs indented with └─, unanswered highlighted
Right-bottom (70% x 35%): Context-sensitive details (see DetailsPanel below)
Bottom row: StatusBar — ↑↓/jk:Navigate  Enter:Toggle  1-6:Filter  ?:Help  q:Quit  [!]=errors
```

### TreePanel — Role Display

Each agent row shows: `{dot} {name} ({role}) [N!]`  
- `���` (colored by status) for primary agents, `◦` (dim gray) for secondary (agent appears in multiple rooms)
- Status colors: green=idle, yellow=busy, red=dead, gray=unknown
- Error badge: `[N!]` in red when agent has sent `kind=error` messages (counts all-time errors per agent)
- Scroll windowing: `height - 2` visible lines, `▲ more` / `▼ more` hints

### Tree Selection Tracking

Selection tracks by node ID (`agent:name` or `agent:name:room` for secondary), not numeric index. This survives tree rebuilds when agents join/leave/reorder. Manual navigation disables auto-select (which otherwise follows the most-recently-active agent).

### DetailsPanel — Context-Sensitive Content

| Selection | Content |
|-----------|---------|
| Agent selected | name (bold), status + role + pane, rooms list, last activity, **Agent Stats** (tasks done/error/open, avg completion time, message counts sent/received, active duration), live pane output (rawOutput tail) |
| Room selected | room name, topic, member count, **Task Tracker** (matched task→completion/error pairs with status icon, agent, duration) |
| Nothing selected | **Room Overview** — table of all rooms: name, members, tasks done/err/open, last active (sorted by recency) |
| Syncing | "Syncing…" placeholder |

### Task Tracker (`useTaskTracker`)

Replaces the old aggregate task summary with individual tracked tasks. Matches task messages to completion/error messages using a **most-recent-match** strategy:

1. Collect all `kind=task` messages in the room
2. For each `kind=completion` or `kind=error`: find the most recent open task matching by agent name (`task.to === completion.from`)
3. Fallback: if no agent match, match any open task in the room
4. Display: `✓`/`✗`/`↻` icon + truncated task text + agent + duration (live-updating for open tasks)
5. Sort: open tasks first (oldest first), then completed (newest first)

### Agent Stats

Computed per-agent metrics shown when an agent is selected:
- Tasks: N done, N errors, N open (using same most-recent-match strategy as Task Tracker)
- Avg completion time from matched task→completion pairs
- Messages: N sent, N received
- Active duration since `joined_at`

### Activity Sparklines

Each agent in TreePanel gets a 10-character ASCII sparkline showing message rate over the last 10 minutes (1-minute buckets). Uses block characters `▁▂▃▄▅▆▇█` scaled relative to the agent's own maximum bucket count. Width-adaptive: hides role suffix first, then sparkline entirely on narrow terminals.

### Message Kind Filters

Keys `1-6` toggle visibility of message kinds in the feed: 1=task, 2=completion, 3=error, 4=question, 5=status, 6=chat. Filter state is a `Set<MessageKind>` in App state. When any kind is filtered off, the MessageFeedPanel header shows active filter indicators (e.g., `T:on D:off E:on`). All filters on = clean header.

### Q&A Threading

Questions (`kind=question`) in the message feed are matched to responses:
- Match: subsequent message in same room where `from` matches question's `to` and `to` matches question's `from`, within 5 minutes
- Matched responses are rendered indented with `└─` connector and removed from the main feed flow
- Unanswered questions show `(unanswered — Xm ago)` in yellow
- Threaded responses are filtered out before the maxLines slice to avoid wasting visible slots

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

Dashboard errors go to `/tmp/crew/dashboard.log` (not console, which would corrupt the TUI). A `[!]` indicator appears in the StatusBar when errors exist.

## Installation Architecture

### Claude Code

Uses the Claude Code plugin system (`.claude-plugin/` manifests):

```
git clone → ~/.crew/
bun install
claude plugins marketplace add ~/.crew     → registers .claude-plugin/marketplace.json
claude plugins install crew@crew-plugins   → copies to plugin cache, enables in settings
```

- Plugin cache: `~/.claude/plugins/cache/crew-plugins/crew/0.2.0/`
- Skills namespaced as `/crew:{boss,join-room,leader,worker,refresh}`
- MCP server launched via `.mcp.json` (stdio transport, `bun run ./src/index.ts`)

### OpenAI Codex CLI

Uses the Codex plugin system (`.codex-plugin/` manifests):

```
git clone → ~/.crew/
bun install
codex mcp add crew -- bun run ~/.crew/src/index.ts     → registers MCP server
ln -s ~/.crew ~/.codex/.tmp/plugins/plugins/crew        → makes plugin discoverable
+ add entry to marketplace.json                          → Codex reads plugin metadata
```

- Plugin appears in `/plugins` TUI as "Crew" (Installed)
- Skills namespaced as `crew:{boss,join-room,leader,worker,refresh}`
- MCP tools registered in `~/.codex/config.toml` as STDIO server

**Standalone MCP (no skills):** `codex mcp add crew -- bun run ~/.crew/src/index.ts`

### Plugin Structure (shared)

```
.claude-plugin/       # Claude Code plugin manifest + marketplace.json
.codex-plugin/        # Codex CLI plugin manifest
.mcp.json             # MCP server config (shared by both platforms)
skills/               # 5 bundled skills (SKILL.md format, used by both)
```

### Cross-Platform Compatibility

Both Claude Code and Codex CLI use the MCP protocol (stdio transport). The same `src/index.ts` server works for both — no adapter layer needed. Skills use identical `SKILL.md` format with YAML frontmatter. Platform-specific references (slash commands, `@` mentions) are avoided in bundled skills.

## tmux Delivery — Bracketed Paste

Push messages are delivered to agent tmux panes via `tmux load-buffer` + `paste-buffer -dp` (bracketed paste mode), NOT `send-keys -l`.

### Why not send-keys -l

`send-keys -l` injects characters one-at-a-time into the pane. This causes three problems with modern terminal apps like Claude Code:

1. **Paste detection race:** Claude Code detects rapid keystroke injection as a "paste" and collapses it into `[Pasted N lines...]`. The Enter key sent afterward races against paste processing and can get dropped.
2. **Mid-stream newlines:** Any `\n` in the message text becomes an Enter keypress, submitting partial text before the full message arrives.
3. **Sentinel polling fails:** An earlier fix attempted polling `capture-pane` for a sentinel string before sending Enter, but when Claude Code shows `[Pasted N lines...]` instead of the actual text, the sentinel never matches → 5s timeout → Enter sent too late or state has changed.

### How paste-buffer -dp works

1. `tmux load-buffer -b _crew -` — loads text into a named buffer via stdin (safe for arbitrary content, no shell escaping issues)
2. `tmux paste-buffer -dp -b _crew -t target` — pastes with bracketed paste mode (`-p`), deletes buffer after (`-d`)
3. 500ms settle delay — lets the terminal app finish processing the paste (empirically tested: 80ms fails against Claude Code, 100ms works, 500ms for wide margin across machines/apps)
4. `tmux send-keys -t target Enter` — submits the pasted text

The `-p` flag wraps the text in `\e[200~...\e[201~` escape sequences. Terminal apps that enable bracketed paste mode (Claude Code does) treat the entire payload as one atomic paste — newlines become part of the pasted text, not Enter keypresses.

### Requirements

- tmux 2.4+ (for `paste-buffer -p` flag)
- Target pane app must enable bracketed paste mode (`\e[?2004h`) — Claude Code and most modern terminal apps do this automatically

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

## Task Tracking & Worker Control

### Task Lifecycle
Tasks are tracked in a dedicated `tasks` SQLite table with statuses:
`sent → queued → active → completed/error/interrupted/cancelled`

Tasks are automatically created when `send_message` is called with `kind: "task"`.
Workers update task status via `update_task`. Dead agent tasks are cleaned up automatically.

### Worker Control Tools
- `interrupt_worker` — Leader/Boss only. Sends Escape to worker pane, marks task interrupted.
- `reassign_task` — Leader/Boss only. Replaces queued/active task with new one.
- `clear_worker_session` — Leader/Boss only. Sends `/clear` command to worker pane (clears Claude Code context), then auto-sends `/crew:refresh` to re-register. Use between long task sequences to free context. Worker's next task must be self-contained (cannot reference prior context).
- `update_task` — Worker only. Reports task lifecycle transitions.

### Role Enforcement
The `assertRole` guard (`src/shared/role-guard.ts`) enforces role-based access on control tools.
Existing tools remain role-agnostic.

### Per-Pane Delivery Queue
All tmux output is routed through `PaneQueue` (`src/delivery/pane-queue.ts`):
- One queue per pane, serializes deliveries within a process
- Cross-process serialization via per-pane file locks (`/tmp/crew/locks/`)
- Escape items get priority (jump to front of queue)
- Polls for idle prompt before delivering paste items
- Per-pane buffer names (`_crew_{pane_id}`) prevent cross-pane buffer collisions

## Task Context Sharing

Worker knowledge is preserved in task records for future reference and handoff.

### Context Storage

Tasks table has two note fields with distinct purposes:

- **`note`** — System-level annotations (error messages, status reasons) — set by `update_task` `note` param
- **`context`** — Worker-written knowledge (files explored, key findings, decisions made) — set by `update_task` `context` param

Example context: "Explored src/auth.ts. Found JWT validation in middleware.ts line 42. Token expiry is 1 hour (should be 24h). Also checked database schema — no migration needed."

### Context Query Tools

Two new MCP tools allow workers and leaders to share knowledge:

- **`get_task_details`** — Returns full task record including context
  - Used to read what a previous worker learned
  - Caller: leader investigating task, worker seeking prior context
  
- **`search_tasks`** — Search completed tasks by room, agent, keyword, or status
  - Supports LIKE search on both `summary` and `context` fields
  - Example: search for "JWT" to find all tasks mentioning JWT issues
  - Default limit: 10 results, ordered by most recent first
  - Returns context as preview (truncated to 200 chars + "...")

### Implementation

- **Storage**: SQLite `tasks` table, `context TEXT` column (nullable, backward compatible)
- **Query**: `searchTasks` in `src/state/index.ts` builds dynamic WHERE clauses and LIKE patterns
- **API**: `update_task` tool accepts optional `context` param (worker → leader handoff)

## Dashboard Views

The dashboard supports three complementary views of agent activity and task progress, switchable via Tab key.

### View Switching

Press **Tab** to cycle through three views:
1. **Dashboard** — Default. Room/agent tree (left), messages + details (right). Original layout.
2. **Task Board** — Task-focused view. Groups tasks by agent or room (toggle with `r`), shows status, duration, context preview. Navigate with `j`/`k`, expand with Enter to see full history.
3. **Timeline** — Waterfall chart. One row per agent, horizontal bars showing task status periods over time. Zoom with `+`/`-`, scroll with `j`/`k`/`h`/`l`.

### Task Board

Groups completed and in-progress tasks:

- **Grouping**: Toggle with `r` key between "grouped by agent" or "grouped by room"
- **Navigation**: `j`/`k` to move up/down, `j`/`k` also wrap within groups
- **Selection**: Highlighted task shown with `▶` prefix
- **Expansion**: Press Enter on a task to expand and show:
  - Full summary text
  - Full context field (worker knowledge notes)
  - Status history: timestamps + transitions (sent → queued → active → completed) + who triggered each
  - Total duration from first event to last event
- **Status indicators**:
  - `✓` = completed (green)
  - `✗` = error (red)
  - `●` = active (yellow)
  - `◌` = queued/sent (cyan)
- **Line format**: `#12 ✓ completed wk-03 Fix auth middleware (2m 34s) JWT tokens expire too early...`

### Timeline

Horizontal waterfall chart showing task execution over time:

- **Time axis**: X-axis represents absolute time elapsed. Automatically scales to fit all task events.
- **Agent rows**: One row per agent with their tasks rendered as Unicode block characters:
  - `░` = queued/sent (cyan)
  - `▓` = active (yellow)
  - `█` = completed (green)
  - `▒` = error (red)
- **Colors**: Status-coded by state transition
- **Zoom controls**: 
  - `+` to zoom in (narrow time window, see fine detail)
  - `-` to zoom out (wide time window, see full history)
- **Scroll controls**:
  - `j`/`k` or up/down arrows: scroll vertically through agents
  - `h`/`l` or left/right arrows: scroll horizontally through time
- **Time labels**: Bottom axis shows relative timestamps (e.g., "2m 34s", "45s")

### Task Events Table

Drives the timeline and task board detail views. Every task status transition is recorded in the `task_events` table:

```sql
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  from_status TEXT,          -- null for initial creation
  to_status TEXT NOT NULL,   -- 'sent', 'queued', 'active', 'completed', 'error', 'interrupted'
  triggered_by TEXT,         -- agent name or 'system'
  timestamp TEXT NOT NULL    -- ISO 8601 datetime
);
```

**Automatic recording**: Every `update_task` call automatically records a transition event. Timeline and Task Board views query this table to reconstruct execution history.

## Token Usage Tracking

Crew automatically collects token consumption and cost data from Claude Code and Codex CLI sessions.

### Data Sources

- **Claude Code**: Parses JSONL conversation logs from `~/.claude/projects/` (primary source)
  - Path pattern: `~/.claude/projects/<project-hash>/<sessionId>.jsonl`
  - Each assistant turn includes `usage` block with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`
- **Codex CLI**: Queries `~/.codex/state_5.sqlite` threads table
  - Stores `tokens_used` (total only — split 70/30 input/output for cost calculation)

### Agent Type Detection

On `join_room`, agent type is auto-detected and stored in `agent_type` column:

```ts
agent_type: 'claude-code' | 'codex' | 'unknown'
```

Detection process (`src/tools/join-room.ts::detectAgentType`):
1. Get shell PID from tmux pane: `tmux display-message -p '#{pane_pid}'`
2. Get child process name: `ps -o comm --ppid <shellPid>` or `pgrep -P <shellPid>`
3. Match process name: "claude" → `'claude-code'`, "codex" → `'codex'`, default → `'unknown'`

### PID Mapping Chain

Token collection resolves Claude Code session paths via PID inspection:

```
tmux pane (%141)
  → tmux display-message '#{pane_pid}' = shell PID (62240)
  → pgrep -P 62240 = claude PID (10846)
  → ~/.claude/sessions/10846.json
    {
      "pid": 10846,
      "sessionId": "41ceb61a-...",
      "cwd": "/Users/lee/code/utils/agent-crew",
      "startedAt": 1775903669908,
      "kind": "interactive",
      "name": "leader"
    }
  → ~/.claude/projects/-Users-lee-code-utils-agent-crew/41ceb61a....jsonl
```

Implementation in `src/tokens/pid-mapper.ts`:
- `getClaudePidFromPane(paneTarget)` — spawns tmux + pgrep, returns claude PID
- `getSessionForPid(pid)` — reads `~/.claude/sessions/<pid>.json`
- `resolveSessionPath(sessionId, cwd)` — builds `~/.claude/projects/` path
- `resolveAgentSession(paneTarget)` — full chain: pane → PID → session → path

### Collection Loop

`startTokenCollection()` in `src/tokens/collector.ts` runs every 30 seconds:

1. Gets all registered agents: `getAllAgents()`
2. Routes each agent by `agent_type`:
   - `'claude-code'` → `collectClaudeCodeTokens(agentName, paneTarget)`
   - `'codex'` → `collectCodexTokens(agentName)`
   - `'unknown'` → tries Claude Code first, then Codex (fallback)
3. Collection functions compare latest snapshot with previous and insert only if changed (dedup)
4. Failures are caught and logged — loop continues for other agents

### Storage

Two SQLite tables (in same `crew.db`):

**`token_usage`** — Snapshot rows:
```sql
CREATE TABLE token_usage (
  id INTEGER PRIMARY KEY,
  agent_name TEXT NOT NULL,
  session_id TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  source TEXT,         -- 'jsonl' | 'codex_db'
  recorded_at TEXT
);
```

**`pricing`** — Configurable per-model costs:
```sql
CREATE TABLE pricing (
  model_name TEXT PRIMARY KEY,
  input_cost_per_million REAL,
  output_cost_per_million REAL
);
```

Default pricing includes Claude Opus/Sonnet/Haiku variants, GPT-4, and Gemini models. Use `upsertPricing(modelName, inputCost, outputCost)` to update.

### Cost Calculation

**Claude Code** (`src/tokens/claude-code.ts`):
```ts
const pricing = getPricingForModel(model);
const cost = pricing
  ? (input_tokens / 1_000_000) * pricing.input_cost_per_million +
    (output_tokens / 1_000_000) * pricing.output_cost_per_million
  : null;
```

**Codex** (`src/tokens/codex.ts`):
```ts
const estInput = Math.round(tokens_used * 0.7);
const estOutput = Math.round(tokens_used * 0.3);
const cost = pricing
  ? (estInput / 1_000_000) * pricing.input_cost_per_million +
    (estOutput / 1_000_000) * pricing.output_cost_per_million
  : null;
```

### Dashboard Integration

**HeaderStats** (top row):
- Shows total crew cost: `Cost: $X.XX (Ntok)`
- Deduplicates latest snapshot per agent (tokenUsage sorted DESC by recorded_at)

**DetailsPanel** (agent selection):
- Shows per-agent model, input/output tokens, and calculated cost

**TreePanel** (agent tree):
- Inline cost display next to each agent: `● builder-1 (worker) $1.25`

### Key Files

- `src/tokens/pid-mapper.ts` — PID → session resolution
- `src/tokens/claude-code.ts` — JSONL parsing + Claude Code token collection
- `src/tokens/codex.ts` — Codex DB querying + Codex token collection
- `src/tokens/collector.ts` — 30s collection loop, agent_type routing
- `src/state/index.ts` — CRUD ops: `recordTokenUsage()`, `getTokenUsageForAgent()`, `getTotalCost()`, `getPricing()`, `upsertPricing()`
- `src/dashboard/components/HeaderStats.tsx` — Cost summary in header
- `src/dashboard/components/TreePanel.tsx` — Inline per-agent cost
- `src/dashboard/hooks/useStateReader.ts` — Reads `token_usage` table into dashboard state
