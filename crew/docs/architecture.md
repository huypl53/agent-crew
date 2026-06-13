# Crew Architecture

Multi-agent coordination system for AI coding agents via tmux rooms. Three-tier hierarchy: Boss → Leaders → Workers. State in SQLite, delivery via tmux bracketed paste.

## Directory Layout

```
crew/src/
├── cli.ts                  # CLI entrypoint (#!/usr/bin/env bun)
├── cli/
│   ├── router.ts           # Command → handler registry (24 commands)
│   ├── parse.ts            # argv parser (--flag value → {flags, positional})
│   └── formatter.ts        # Human-readable output per command
├── config.ts               # Singleton config (env var overrides)
├── delivery/
│   ├── index.ts            # deliverMessage() — main delivery orchestrator
│   └── pane-queue.ts       # PaneQueue — per-pane async delivery queue
├── server/
│   └── sweep.ts            # Background idle/liveness monitor (5s interval)
├── shared/
│   ├── types.ts            # All interfaces, enums, helpers (Agent, Room, Message, Task…)
│   ├── pane-status.ts      # Hash-based pane activity detection
│   ├── role-guard.ts       # assertRole() — role-based auth
│   ├── path-utils.ts       # normalizePath() — symlink resolution
│   └── server-log.ts       # Deduplicating file logger (1MB cap)
├── state/
│   ├── db.ts               # SQLite schema, migrations, init
│   ├── db-write.ts         # Write ops (short-lived connections)
│   └── index.ts            # Main state API (agents, rooms, messages, tasks, tokens)
├── tmux/
│   └── index.ts            # All tmux operations (send, capture, liveness, session mgmt)
├── tokens/
│   ├── claude-code.ts      # Claude Code JSONL token collector
│   ├── codex.ts            # Codex SQLite token collector
│   ├── collector.ts        # 30s periodic collection orchestrator
│   └── pid-mapper.ts       # tmux pane → Claude session PID resolution
├── tools/                  # 24 tool handlers (shared by CLI + MCP)
│   ├── join-room.ts        # Register agent in room
│   ├── leave-room.ts       # Leave room
│   ├── send-message.ts     # Send push/pull message
│   ├── read-messages.ts    # Read room log / inbox
│   ├── get-status.ts       # Agent status + task info
│   ├── check-changes.ts    # Version checkpoint polling
│   ├── create-room.ts      # Create virtual room
│   ├── delete-room.ts      # Delete room + cascade
│   ├── list-rooms.ts       # List all rooms
│   ├── list-members.ts     # List room members
│   ├── set-room-topic.ts   # Set room objective
│   ├── update-task.ts      # Worker: update task status
│   ├── interrupt-worker.ts # Leader/Boss: send Escape + interrupt task
│   ├── reassign-task.ts    # Leader/Boss: replace worker's task
│   ├── clear-worker-session.ts  # Leader/Boss: /clear + /refresh worker
│   ├── get-task-details.ts # Get task with context notes
│   ├── search-tasks.ts     # Search completed tasks
│   ├── polling-control.ts  # Pause/resume/set-busy sweep delivery
│   ├── mute-idle.ts        # Mute/unmute leader idle notifications
│   ├── wait-idle.ts        # Block until tmux pane stable (exit code)
│   └── refresh.ts          # Re-register agent after pane change
```

---

## Data Model

### SQLite Schema (`state/db.ts`)

WAL mode, 5s busy_timeout, foreign keys enabled. Path: `$CREW_STATE_DIR/crew.db` (default `/tmp/crew/state/crew.db`).

```
rooms              agents              messages
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ id (PK)      │←──│ room_id (FK) │←──│ room_id (FK) │
│ path         │   │ id (PK)      │   │ id (PK)      │
│ name         │   │ name         │   │ sender       │
│ topic        │   │ role         │   │ recipient    │
│ created_at   │   │ pane         │   │ text         │
└──────────────┘   │ agent_type   │   │ kind         │
                   │ status       │   │ mode         │
                   │ persona      │   │ timestamp    │
                   │ capabilities │   │ reply_to     │
                   │ idle_muted   │   └──────────────┘
                   │ registered_at│
                   │ last_activity│         tasks
                   └──────────────┘   ┌──────────────┐
                                      │ id (PK)      │
         cursors                      │ room_id (FK) │
         ┌──────────────┐             │ assigned_to  │
         │ agent_id(FK) │             │ created_by   │
         │ last_seq     │             │ message_id   │
         └──────────────┘             │ summary      │
                                      │ status       │
         token_usage                  │ note         │
         ┌──────────────┐             │ context      │
         │ id (PK)      │             │ created_at   │
         │ agent_id(FK) │             │ updated_at   │
         │ session_id   │             │ last_notified│
         │ model        │             └──────────────┘
         │ input_tokens │
         │ output_tokens│   task_events
         │ cost_usd     │   ┌──────────────┐
         │ source       │   │ id (PK)      │
         │ recorded_at  │   │ task_id (FK) │
         └──────────────┘   │ from_status │
                            │ to_status   │
         pricing            │ triggered_by│
         ┌──────────────┐   │ timestamp   │
         │ model_name(PK)│  └──────────────┘
         │ input_cost/M │
         │ output_cost/M│   change_log
         └──────────────┘   ┌──────────────┐
                            │ scope (PK)   │
         sweep_control      │ version      │
         ┌──────────────┐   │ updated_at   │
         │ id = 1       │   └──────────────┘
         │ paused       │
         │ pause_reason │   agent_templates / room_template_definitions
         │ busy_mode    │   (reusable provisioning configs)
         │ updated_at   │
         └──────────────┘
         hook_events
         ┌──────────────┐
         │ id (PK)      │
         │ agent_name   │
         │ event_type   │
         │ session_id   │
         │ payload      │
         │ created_at   │
         └──────────────┘
```

### Key Enums

```
AgentRole    = boss | leader | worker
AgentStatus  = idle | busy | dead | unknown
MessageKind  = task | completion | question | error | status | chat | note
TaskStatus   = sent | queued | active | completed | error | interrupted | cancelled
SweepBusyMode = auto | manual_busy | manual_free
```

### Task State Machine

```
sent → queued | active | error
queued → active | cancelled | error
active → completed | error | interrupted
interrupted → active | error
```

Transitions validated in `state/index.ts` via `VALID_TRANSITIONS` map. Each transition logged in `task_events`.

### Change Tracking

DB triggers auto-increment `change_log.version` on INSERT/UPDATE to `messages`, `agents`, `tasks`, `agent_templates`, `room_template_definitions`, `hook_events`. Scopes: `messages`, `agents`, `tasks`, `templates`, `room-templates`, `hook-events`. Used by WebSocket poller to broadcast only real changes.

---

## Core Flows

### 1. Agent Registration (join-room)

```
crew join --room crew --role worker --name wk-01 --pane %42
     │
     ▼
cli.ts → parseArgs → COMMANDS['join'].handler
     │
     ▼
handleJoinRoom()
  1. Validate role (boss|leader|worker)
  2. Resolve tmux target (param > $TMUX_PANE > null for pull-only)
  3. Get pane CWD → normalizePath()
  4. Generate random name if none provided (role prefix + suffix)
  5. Remove stale agents using same pane
  6. getOrCreateRoom(path, name)
  7. Resolve name collisions (add suffix)
  8. detectAgentType(pane) — check process tree for 'claude'|'codex'
  9. addAgent() → INSERT into agents table
  10. installHooks(cwd) — Install Stop + UserPromptSubmit hooks in .claude/settings.local.json
  11. Paste room topic into agent's pane
  12. Rename Claude Code session to "name@room"
  └── Return {name, role, room, pane}
```

### 2. Message Delivery (send)

```
crew send --room crew --text "build auth" --name boss --kind task --to wk-01
     │
     ▼
handleSendMessage()
  1. Validate params (room, text, name required)
  2. Verify sender registered + room member
  3. Sender verification (optional pane match)
  4. Task messages require --to (no broadcast tasks)
     │
     ▼
deliverMessage() [delivery/index.ts]
  1. Format: "[sender@room]: text"
  2. addMessage() → INSERT into messages, update agent status
     - task kind → set recipient busy
     - completion/error/question → set sender idle
  3. If kind=task → createTask() in DB
     │
     ▼ push mode:
  4. Get agent, validate pane exists
  5. Check agent process alive (claude-code/codex)
  6. getQueue(pane) → PaneQueue singleton
  7. enqueue({type:'paste', text: formatted + role suffix})
     │
     ▼
PaneQueue.process() [delivery/pane-queue.ts]
  1. waitForReady() — poll until no active typing (max 10s)
  2. applyLeaderPacing() — if leader target, delay between pastes
  3. withLock() — async mutex per pane
  4. tmux sendKeys() — paste-buffer -dp (bracketed paste)
  5. Role suffix appended:
     - worker: "Remember: You are a worker. Execute tasks, report results."
     - leader: "Remember: You are a leader. Manage workers, assign tasks, track progress."
     - boss: "Remember: You are the boss. Direct leaders, review milestones."
     │
     ▼ pull mode:
  4. Message stays in DB only, agent reads via crew read
```

### 3. Message Reading (read)

```
crew read --name wk-01 --room crew --kinds task,completion
     │
     ▼
handleReadMessages()
  1. Validate agent exists
  2. readRoomMessages(agentName, room, kinds, limit)
     │
     ▼
readRoomMessages() [state/index.ts]
  1. Get cursor for (agentName, room) — last read message ID
  2. Query messages WHERE room_id = X AND id > cursor
  3. Filter: messages addressed to this agent OR broadcasts (no recipient)
  4. Filter by kinds if specified
  5. advanceCursor() — update cursor to latest read ID
  6. Return messages + next_sequence
```

### 4. Hook-Driven Idle Detection

Claude Code hooks provide reliable idle detection without content hashing or tmux polling overhead.

**Hook Installation** (`hooks/install-hooks.ts`)
- Runs on agent spawn (`join-room`)
- Writes to `.claude/settings.local.json` in room directory
- Installs two hooks: `Stop` (response completion) and `UserPromptSubmit` (user input)
- Command: `crew hook-event || true` (failsafe to not block Claude)

**Hook Event Processing** (`tools/hook-event.ts`)
- Reads hook JSON from stdin
- Resolves agent via `$TMUX_PANE` environment variable
- Writes event to `hook_events` table: agent_name, event_type, session_id, payload
- Returns silently (hooks run async, output ignored)

**Database Schema** (`state/db.ts`)
```sql
CREATE TABLE hook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  event_type TEXT NOT NULL,        -- 'Stop' | 'UserPromptSubmit'
  session_id TEXT,
  payload TEXT,                    -- Full hook JSON
  created_at TEXT NOT NULL
);
CREATE INDEX idx_hook_events_agent ON hook_events(agent_name);
CREATE INDEX idx_hook_events_type ON hook_events(agent_name, event_type);
```

**Timestamp Gotcha:** SQLite `datetime('now')` returns UTC without `Z` suffix (e.g. `2026-05-08 10:41:24`). JS `new Date()` parses this as local time. Always append `'Z'` when converting: `new Date(event.created_at + 'Z')`. Also truncates to whole seconds — use 1s tolerance for same-second comparisons.

**Status Resolution** (`shared/pane-status.ts`)
- `getPaneStatus(pane)` uses hook events as primary signal
- Latest `Stop` event → agent idle (response completed)
- Latest `UserPromptSubmit` event → agent busy (processing user input)
- Falls back to `unknown` if no events (hooks not yet installed)
- Still uses tmux input box parsing for `typingActive` detection
- `contentChanged` tracks per-pane `lastSeenEventId` — only `true` when a new hook event appears

**Sweep Integration** (`server/sweep.ts`)
- Queries `getLatestHookEvent(agentName, 'Stop')` and `UserPromptSubmit`
- If `UserPromptSubmit` is newer → reset idle tracking (agent busy)
- If `Stop` is newer and ≥60s unchanged → notify leader (agent idle)
- No more dual-hash content comparison or ANSI color capture


### 5. Idle Detection & Sweep

Runs every 5 seconds. Two subsystems: idle detection (notify leaders) and liveness check (clean dead agents).

```
startSweep() [server/sweep.ts]
  │ setInterval(5000ms)
  ▼
runIdleDetection()
  For each worker in each room:
    1. paneCommandLooksAlive(pane) — check agent process running
    2. Query hook events: getLatestHookEvent(worker.name, 'Stop')
    3. Query hook events: getLatestHookEvent(worker.name, 'UserPromptSubmit')
    4. Compare event timestamps:
       - UserPromptSubmit newer → reset idle tracking (busy)
       - Stop ≥60s ago AND not notified this epoch → mark idle
    5. If idle detected:
       a. Build notification: "[system@room]: worker idle (Xm)"
       b. Extract `last_assistant_message` from Stop hook payload as context
       c. Stage per-leader: Map<leader, Map<worker, msg>>
  │
  ▼
processDelivery()
  For each leader:
    Check pause/busy mode:
    - delivery_paused → defer all
    - manual_busy → defer all
    - manual_free → deliver immediately
    - auto → probe pane status via hook events, defer if busy
    │
    If deliver:
      1. Merge deferred + incoming messages (coalesce per worker)
      2. Paste combined notification to leader's pane
      3. On success → clear deferred, emit flush event
      4. On dead pane → remove queue, clear deferred
      5. On typing busy → re-stage deferred
  │
  ▼ every 30s (6th tick):
runLivenessCheck()
  Skip if in warmup (first 30s)
  For each agent:
    1. paneCommandLooksAlive(pane)
    2. If alive → reset dead counter, update status
    3. If dead → increment dead counter
       - Boss/Leader → mark dead, keep in DB
       - Worker with active tasks → log warning, skip
       - Worker no tasks + count ≥ 2 → markAgentStale()
         - cleanupDeadAgentTasks() → force all active tasks to error
         - removeAgentFully() → delete from all rooms
```

### 6. Task Lifecycle

```
Leader sends task:
  crew send --kind task --to wk-01 --text "build auth"
  → createTask(room, worker, leader, msgId, "build auth")
  → status: 'sent'
  → task_events: null → 'sent'

Worker acknowledges:
  crew update-task --task 5 --status queued
  → validate: sent → queued ✓
  → task_events: 'sent' → 'queued'

Worker starts:
  crew update-task --task 5 --status active --note "starting"
  → validate: queued → active ✓
  → task_events: 'queued' → 'active'

Worker completes:
  crew update-task --task 5 --status completed --note "done" --context "findings..."
  → validate: active → completed ✓
  → task_events: 'active' → 'completed'
  → sender status → idle

Leader reassigns (mid-task):
  crew reassign --worker wk-01 --room crew --text "new task"
  → Find active/queued task → interrupt/cancel
  → Send Escape to worker pane (priority)
  → Create new task + message
  → Paste new task to worker

Leader interrupts:
  crew interrupt --worker wk-01 --room crew
  → Find active task
  → Send Escape (priority queue)
  → Mark task 'interrupted'
  → Paste notification to worker

Leader clears session:
  crew clear --worker wk-01 --room crew
  → Cancel all queued/sent tasks
  → Send /clear command
  → Wait 2s
  → Send /crew:refresh (re-register)
  → Rename session

Leader compacts context:
  crew compact --worker wk-01 --room crew "optional message"
  → Send /compact [message] command
  → No refresh needed (session preserved)
```

### 7. Token Collection

```
startTokenCollection() [tokens/collector.ts]
  │ setInterval(30_000ms)
  ▼
collectAllTokens()
  For each agent:
    switch (agent_type):
      claude-code → collectClaudeCodeTokens(name, pane)
        1. resolveAgentSession(pane) [pid-mapper.ts]
           - tmux display-message → shell PID
           - pgrep -P → child PIDs
           - find ~/.claude/sessions/{pid}.json → session metadata
           - resolve sessionPath → ~/.claude/projects/{hash}/{sessionId}.jsonl
        2. Read JSONL file, parse lines with type='assistant'
        3. Extract: input_tokens, output_tokens, model
        4. Sum all entries
        5. Dedup check: compare session ID + tokens with DB
        6. getPricingForModel() → cost calculation
        7. recordTokenUsage() → UPSERT into token_usage

      codex → collectCodexTokens(name)
        1. Read ~/.codex/state_5.sqlite (read-only)
        2. Get latest thread with tokens_used
        3. Dedup check
        4. Estimate 70% input / 30% output
        5. getPricingForModel() → cost calculation
        6. recordTokenUsage()

      unknown → try claude-code first, then codex
```

---

## PaneQueue — Per-Pane Delivery Queue

Singleton per tmux target. Key behaviors:

- **Queue items**: `paste` (content + role suffix), `command` (raw CLI), `escape` (high priority), `clear` (Ctrl-L)
- **Wait for ready**: Hook event fast-path (recent event = ready), otherwise polls pane content hash every 500ms until no typing detected (max 10s timeout)
- **Leader pacing**: Configurable delay (default 7s) between paste deliveries to leaders
- **Async mutex**: Ensures sequential delivery per pane — no interleaving
- **Error types**: `PANE_DEAD`, `PANE_NOT_READY_TYPING`, `DELIVERY_FAILED`
- **Polling intervals**: Conservative=500ms fixed; Reduced=worker 2s, leader 5s, boss 10s (falls back to 500ms if no heartbeat 30s)

---

## Tmux Integration

### Delivery (tmux/index.ts)

Uses `tmux paste-buffer -dp` (bracketed paste) instead of `send-keys -l` to prevent Claude Code from collapsing multi-line input into "[Pasted N lines...]". 500ms settle time after paste, then Enter to submit.

### Liveness Detection

Regex pattern `/^(node|bun|claude|codex)/i` on pane process name. Distinguishes agent processes from plain shells (bash, zsh, fish).

### Pane Status (pane-status.ts)

Hook-driven approach with tmux fallback:
- **Primary signal**: Latest hook event from Claude Code (Stop = idle, UserPromptSubmit = busy)
- **Fallback**: Returns `unknown` if no hook events (hooks not yet installed)
- **Input detection**: Still uses tmux input box parsing for `typingActive` state
- **Content changed**: Derived from hook event transitions (Stop = content changed)
- Legacy dual-hash approach removed — no more content hashing or ANSI capture

### Socket Handling

Supports `CREW_TMUX_SOCKET` env var for isolated test sockets. Falls back to scanning all tmux sockets if primary fails.

### Hook Events (hook-event CLI)

Ingests Claude Code hook events via stdin:

```bash
crew hook-event < hook-payload.json
# OR via hook: crew hook-event || true
```

**Flow**:
1. Read JSON from stdin (hook payload)
2. Resolve agent via `$TMUX_PANE` environment variable
3. Parse `hook_event_name` field (Stop, UserPromptSubmit)
4. Extract `session_id` if present
5. Insert into `hook_events` table
6. Return silently (hooks run async, output ignored)

**Silent failures**: Malformed JSON, missing pane, unknown agent → return `{ok: true}` to avoid blocking Claude Code.

### Wait-Idle Utility (wait-idle)

Blocks until agent pane becomes idle, using hook events as fast-path:

```bash
crew wait-idle --pane %42
```

**Algorithm**:
1. Try hook events first (if agent registered in DB)
2. Query latest `Stop` event for agent
3. If `Stop` timestamp ≥ start time → return idle
4. Otherwise, poll every 1s until timeout (default 60s)
5. Fallback to tmux hash-based polling if no agent/hooks
6. Return `{idle, content, elapsed, timedOut}`

**Use case**: Synchronous scripts that need to wait for agent completion before proceeding.

---

## Config Surface

| Env Var | Default | Purpose |
|---------|---------|---------|
| `CREW_STATE_DIR` | `/tmp/crew/state` | SQLite DB directory |
| `CREW_TMUX_SOCKET` | auto | tmux socket for test isolation |
| `CREW_SENDER_VERIFICATION` | `log` | `off`/`log`/`enforce` — pane-based auth |
| `CREW_POLLING_PROFILE` | `reduced` | `conservative` (500ms) or `reduced` (role-based) |
| `CREW_LEADER_PACE_MS` | `7000` | Delay between paste deliveries to leaders |
| `TMUX_PANE` | auto | Current tmux pane (set by tmux) |

---

## Sweep Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `SWEEP_INTERVAL_MS` | 5000 | Main sweep tick |
| `IDLE_THRESHOLD_MS` | 60000 | Time unchanged before idle |
| `ANSI_CHECK_LINES` | 8 | Lines for color change detection |
| `NOTIFY_THROTTLE_MS` | 1_800_000 | 30 min between notifications per worker |
| `LIVENESS_TICKS` | 6 | Check liveness every 6th tick (30s) |
| `WARMUP_MS` | 30000 | Grace period before liveness checks |
| `DEAD_THRESHOLD` | 2 | Consecutive dead checks before removal |
| `AUTO_BUSY_WINDOW_MS` | 15000 | Busy window after content detected |
| `MAX_DEFERRED_PER_LEADER` | 200 | FIFO eviction limit |

---

## Role Hierarchy & Permissions

```
Boss (your session)
 ├── Can: manage leaders, delete rooms, interrupt/clear/reassign any worker
 ├── Never removed by liveness check
 └── Rooms: company room
      │
      ▼
Leader (coordinates workers)
 ├── Can: assign tasks, interrupt/clear/reassign workers in room
 ├── Can: mute/unmute idle notifications
 ├── Never removed by liveness check
 └── Polling control: pause/resume sweep delivery
      │
      ▼
Worker (executes tasks)
 ├── Can: update own task status, send messages
 ├── Can be: interrupted, reassigned, cleared by leader/boss
 ├── Removed after 2 dead checks if no active tasks
 └── Auto-notifies leaders on completion/error/question
```

### Message Routing Rules

- Workers broadcast to leaders only (not to other workers)
- Workers sending completion/error/question auto-push to all leaders in room
- Leaders receive coalesced idle notifications (multiple workers merged)
- Task messages require explicit `--to` target (no broadcast tasks)

---

## Auto-Notify System

When a worker sends a message with kind `completion`, `error`, or `question`, the system automatically:

1. Captures context tail (last 20 lines from worker's pane)
2. Sends push notification to all leaders in the room:
   ```
   [system@room]: workerName completion: "summary" [context: ...]
   ```
3. Sets worker status to `idle`

---

