# Room-Scoped Agent Identity Design

**Date:** 2026-04-18  
**Status:** Approved  
**Author:** Brainstorm session

## Problem Statement

Current design allows agents to exist in multiple rooms via `members` junction table. This conflicts with the mental model where:
- Room = project with real local path
- Agent works on one project at a time
- Same agent name in different rooms should be different agents

Additionally, pane IDs are ephemeral (change on tmux restart), making them unsuitable as persistent identity.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Room identity | `path` (with surrogate `id` PK) | Filesystem path is stable, unique |
| Agent identity | `(room_id, name)` composite | Name unique within project context |
| Pane | Ephemeral session binding | Updated on join, not identity |
| Multi-room | Not allowed | Agent belongs to exactly one room |
| Cross-room messaging | Not allowed | Communication scoped to project |
| Room deletion | CASCADE | Delete room removes all agents/messages |
| Message sender/recipient | Agent name (TEXT) | Room context disambiguates |

## Schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- Rooms: identified by local project path
CREATE TABLE rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,        -- real identity
  name TEXT NOT NULL,               -- human label (can repeat)
  topic TEXT,
  created_at TEXT NOT NULL
);

-- Agents: scoped to exactly one room
CREATE TABLE agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  pane TEXT,                        -- ephemeral tmux binding
  agent_type TEXT NOT NULL DEFAULT 'unknown',
  registered_at TEXT NOT NULL,
  last_activity TEXT,
  status TEXT,
  persona TEXT,
  capabilities TEXT,
  UNIQUE(room_id, name)
);

-- Messages: scoped to room
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  recipient TEXT,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  mode TEXT,
  timestamp TEXT NOT NULL,
  reply_to INTEGER REFERENCES messages(id)
);

-- Cursors: per-agent read position (simplified - one cursor per agent)
CREATE TABLE cursors (
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  last_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id)
);

-- Tasks: scoped to room
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  assigned_to TEXT NOT NULL,
  created_by TEXT NOT NULL,
  message_id INTEGER,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  note TEXT,
  context TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  triggered_by TEXT,
  timestamp TEXT NOT NULL
);

CREATE TABLE token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  session_id TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  source TEXT NOT NULL DEFAULT 'statusline',
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE pricing (
  model_name TEXT PRIMARY KEY,
  input_cost_per_million REAL NOT NULL,
  output_cost_per_million REAL NOT NULL
);

-- Change tracking for dashboard polling
CREATE TABLE change_log (
  scope TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Agent templates (room-independent)
CREATE TABLE agent_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'worker',
  persona TEXT,
  capabilities TEXT,
  created_at TEXT NOT NULL
);

-- Room templates: link agent templates to rooms
CREATE TABLE room_templates (
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  template_id INTEGER NOT NULL REFERENCES agent_templates(id) ON DELETE CASCADE,
  PRIMARY KEY (room_id, template_id)
);

-- Room template definitions (blueprints for creating rooms)
CREATE TABLE room_template_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  topic TEXT,
  agent_template_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

-- Triggers for change_log
CREATE TRIGGER trg_messages_change AFTER INSERT ON messages
BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'messages'; END;

CREATE TRIGGER trg_tasks_change AFTER UPDATE ON tasks
BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'tasks'; END;

CREATE TRIGGER trg_tasks_insert AFTER INSERT ON tasks
BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'tasks'; END;

CREATE TRIGGER trg_agents_change AFTER INSERT ON agents
BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'agents'; END;

CREATE TRIGGER trg_agents_update AFTER UPDATE ON agents
BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'agents'; END;

CREATE TRIGGER trg_agents_delete AFTER DELETE ON agents
BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'agents'; END;

CREATE TRIGGER trg_templates_ins AFTER INSERT ON agent_templates
BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'templates'; END;

CREATE TRIGGER trg_templates_upd AFTER UPDATE ON agent_templates
BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'templates'; END;

CREATE TRIGGER trg_templates_del AFTER DELETE ON agent_templates
BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'templates'; END;

CREATE TRIGGER trg_room_tpl_ins AFTER INSERT ON room_template_definitions
BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'room-templates'; END;

CREATE TRIGGER trg_room_tpl_upd AFTER UPDATE ON room_template_definitions
BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'room-templates'; END;

CREATE TRIGGER trg_room_tpl_del AFTER DELETE ON room_template_definitions
BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'room-templates'; END;
```

## Removed Tables

- `members` — No longer needed. Agents have direct `room_id` FK.

## Key Flows

### Agent Registration (Join)

```
1. Agent runs: crew join --room <name> --name <agent-name>
2. Capture pane CWD via tmux
3. Normalize path: realpath() + strip trailing slash
4. Find or create room by path
5. Find or create agent by (room_id, name)
6. Update agent.pane to current pane ID
7. Return agent info
```

### Pane Recovery (Restart)

```
1. Agent restarts, runs: crew join --room <name> --name <agent-name>
2. Same flow as registration
3. Existing agent row found by (room_id, name)
4. Only pane column updated
5. Messages/tasks preserved
```

### Refresh (Pane Rebind)

```
1. Agent runs: crew refresh --name <agent-name>
2. Capture pane CWD via tmux (see "Capturing Pane CWD")
3. Normalize path → find room by path
4. If room not found: error "Room not found for CWD. Use 'crew join' instead."
5. Find agent by (room_id, name)
6. If agent not found: error "Agent not found. Use 'crew join' instead."
7. Update agent.pane to current pane ID
8. Return agent info with room
```

**Key difference from join:** Refresh requires existing room+agent. Join creates if missing.

### Message Delivery

```
1. Agent sends: crew send --text "hello" [--to <recipient>]
2. Lookup sender agent by pane → get (room_id, name)
3. If recipient specified: validate exists in same room
4. Insert message with room_id, sender name, recipient name
5. Deliver via tmux to recipient pane(s)
```

## Capturing Pane CWD

tmux provides the pane's current working directory via format variables:

```typescript
import { spawnSync } from 'bun';

function getPaneCwd(paneId: string): string | null {
  const result = spawnSync(['tmux', 'display-message', '-p', '-t', paneId, '#{pane_current_path}']);
  if (result.exitCode !== 0) return null;
  const cwd = result.stdout.toString().trim();
  return cwd || null;
}
```

**Usage in join/refresh:**
```typescript
const paneId = process.env.TMUX_PANE;
const cwd = getPaneCwd(paneId);
const normalizedPath = normalizePath(cwd);
const room = findRoomByPath(normalizedPath);
```

## Migration Strategy

**Recommended: Fresh start.** The schema change is fundamental (multi-room → single-room). Attempting to migrate multi-room agents loses data arbitrarily.

1. Detect schema version by checking for `rooms.path` column
2. If old schema detected:
   - Warn user: "Schema v2 requires fresh DB. Back up if needed."
   - Drop all tables
   - Recreate with new schema
3. Initialize `change_log` scopes: agents, messages, tasks, templates, room-templates

**Rationale:** Crew state is ephemeral (agents rejoin on restart). Historical messages are low-value compared to clean identity semantics.

## Path Normalization

To ensure consistent path matching:

```typescript
import { realpathSync } from 'fs';
import { resolve } from 'path';

function normalizePath(p: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(p);  // resolves symlinks
  } catch {
    resolved = resolve(p);  // fallback: resolve without symlink resolution
  }
  return resolved.endsWith('/') ? resolved.slice(0, -1) : resolved;
}
```

Handles:
- Symlinks → resolved to real path (when accessible)
- Non-existent paths → fallback to `path.resolve()` (no crash)
- Trailing slashes → stripped
- Relative paths → resolved to absolute

## Indexes

```sql
CREATE INDEX idx_agents_room ON agents(room_id);
CREATE UNIQUE INDEX idx_agents_pane ON agents(pane) WHERE pane IS NOT NULL;
CREATE INDEX idx_messages_room ON messages(room_id, id);
CREATE INDEX idx_messages_recipient ON messages(recipient, id);
CREATE INDEX idx_tasks_room ON tasks(room_id, status);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_to, status);
CREATE INDEX idx_token_usage_agent ON token_usage(agent_id, recorded_at);
```

## Breaking Changes

1. `members` table removed
2. `messages.room` changes from TEXT to `room_id` INTEGER
3. `cursors` simplified to single cursor per agent (no room dimension needed since agent is in one room)
4. `token_usage.agent_name` changes to `agent_id`

## Not Changing

- Message `sender`/`recipient` remain TEXT (agent names)
- Task `assigned_to`/`created_by` remain TEXT (agent names)

## CLI Changes

| Command | Before | After |
|---------|--------|-------|
| `crew join --room X` | Room name only | Room name becomes label; path derived from CWD |
| `crew refresh --name X` | Finds agent by name globally | Finds agent by (CWD-derived room, name) |
| `crew send --room X` | Room name lookup | Room resolved via sender's pane → room_id |
| `crew read --room X` | Room name lookup | Room resolved via agent's room_id |

**Room param semantics:**
- `--room` is now a human-friendly label, not the identity
- The actual room is determined by pane CWD (normalized path)
- If `--room` provided, it sets/updates `rooms.name` for that path
