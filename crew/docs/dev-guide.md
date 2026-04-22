# Crew Developer Guide

Companion to `architecture.md`. Focus: gotchas, patterns, test recipes, and quick-reference for the room-scoped identity model.

---

## Identity Model (Critical)

### Room = Filesystem Path

Rooms are identified by **real filesystem path** (`realpathSync` with fallback to `resolve`).

```typescript
// CORRECT: create/fetch by path
getOrCreateRoom('/Users/alice/projects/myapp', 'myapp')

// getRoom() accepts path (starts with '/'), name, or integer ID
getRoom('/Users/alice/projects/myapp')  // by path
getRoom('myapp')                         // by name (first match)
getRoom(3)                               // by integer ID
```

Two sessions pointing at the same directory = same room, regardless of the `name` argument (name gets updated).

### Agent = (room_id, name)

An agent exists in exactly one room. `getAgent(name)` searches globally by name (returns first match across all rooms). For room-scoped lookup:

```typescript
// Global — use when name is globally unique (boss/leader in single-crew setup)
const agent = getAgent('lead-1');

// Room-scoped — use when name could repeat across rooms
const agent = getAgentByRoomAndName(roomObj.id, 'lead-1');
```

### getRoomMembers — takes integer room ID, not name

```typescript
// WRONG (old API):
getRoomMembers('general')

// CORRECT:
const room = getRoom('general');
if (room) getRoomMembers(room.id);
```

This is the most common migration trap. Every caller that used to pass a room name string must now look up the room first.

---

## State Layer Quick Reference

All reads from `src/state/index.ts`, all writes from `src/state/db-write.ts`.

### Common Read Functions

```typescript
getAllRooms(): Room[]
getRoom(identifier: string | number): Room | undefined
getRoomMembers(roomId: number): Agent[]
getAgent(name: string): Agent | undefined
getAgentByRoomAndName(roomId: number, name: string): Agent | undefined
getAllAgents(): Agent[]
readRoomMessages(agentName, room, kinds?, limit?): { messages, next_sequence }
readMessages(agentName, room?, sinceSequence?): { messages, next_sequence }
getCursor(agentName, room): number
searchTasks(filter): Task[]
```

### Common Write Functions (db-write.ts)

```typescript
dbCreateRoom(name, topic?, templateIds?): { error?: string }
dbDeleteRoom(name): { error?: string }             // CASCADE removes all children
dbSetTopic(name, topic): { error?: string }
dbUpdateAgentPersona(name, persona): { error?: string }
dbUpdateAgentCapabilities(name, caps): { error?: string }
dbDeleteAgent(name): { removed_from_rooms: string[]; error?: string }
```

### addMessage (state/index.ts)

```typescript
addMessage(
  recipient: string,
  sender: string,
  room: string,           // room name (looks up room_id internally)
  text: string,
  mode: 'push' | 'pull',
  targetName: string,     // for broadcast: same as recipient
  kind: MessageKind,
  replyTo?: number | null
): Message
```

---

## Delivery Flow

```
handleSendMessage
  → validate sender.room_id === room.id
  → validate target.room_id === room.id (if directed)
  → deliverMessage(sender, room, text, to, mode, kind, replyTo)
      → addMessage()          always — stores in DB
      → createTask()          if kind === 'task'
      → pane delivery         if mode === 'push' and agent has tmux_target
          → paneExists()      bail if pane dead
          → paneCommandLooksAlive()  bail if shell (not agent process)
          → pane-queue.enqueue()
              → waitForReady()   poll pane until idle/stable-unknown
              → sendKeys()       load-buffer + paste-buffer -dp + Enter
      → auto-notify           if sender.role === 'worker' and kind ∈ {completion, error, question}
          → capturePaneTail(sender.pane, 20)  last 20 non-empty scrollback lines
          → flatten to single line (pipe-separated)
          → enqueue to each leader pane (fire-and-forget)
```

### Push vs Pull

- **push**: message stored in DB + pasted into recipient pane (requires `waitForReady`, ~1-2s per message to real panes)
- **pull**: message stored in DB only; recipient calls `crew read` on their own schedule

Tests that verify DB state (cursors, task creation, message filtering) should use `mode: 'pull'` to avoid the delivery overhead.

### Pane Queue Polling Profiles

| Profile | Interval | Use |
|---------|----------|-----|
| `conservative` | 500ms | Tests; fast turnaround |
| `reduced` (default) | worker: 2s, leader: 5s, boss: 10s | Production |

Set via `config.pollingProfile = 'conservative'` in tests.

---

## Test Patterns

### Basic Setup

```typescript
import { initDb, closeDb } from '../src/state/db.ts';
import { getOrCreateRoom, addAgent } from '../src/state/index.ts';

function mkRoom(name: string) {
  return getOrCreateRoom(`/test/${name}`, name);
}

beforeEach(() => initDb(':memory:'));
afterAll(() => closeDb());
```

`/test/${name}` paths avoid hitting the real filesystem — `normalizePath` calls `realpathSync` which would fail on non-existent paths; the `/test/` prefix doesn't exist but `resolve` fallback handles it.

### Pull Mode for DB Tests

Whenever a test is verifying DB state (cursors, task IDs, message filters) and NOT testing delivery mechanics:

```typescript
// Use mode:'pull' — skips pane delivery, instant return
await handleSendMessage({ room: 'r', text: 'task', to: 'worker', name: 'lead', kind: 'task', mode: 'pull' });
```

### Disable Sender Verification

Tests use real tmux panes that may have different CWDs. Disable the pane-identity check:

```typescript
config.senderVerification = 'off';  // at module level in test file
```

Restore in `afterAll`:

```typescript
const orig = config.senderVerification;
config.senderVerification = 'off';
afterAll(() => { config.senderVerification = orig; });
```

### Test Pane Helpers

```typescript
import { createTestSession, cleanupAllTestSessions, captureFromPane } from './helpers.ts';

let paneA: string;
beforeEach(async () => {
  const s = await createTestSession(`my-test-${Date.now()}`);
  paneA = s.pane;
});
afterAll(() => cleanupAllTestSessions());
```

Real tmux panes are shell panes (not Claude Code). Push delivery works but pastes text into the shell, which may execute it as a command. Design tests to not rely on what the shell does with pasted content.

### Agent Type in Tests

`addAgent` without specifying `agent_type` defaults to `'unknown'`. The `paneCommandLooksAlive` check is only run for `claude-code` and `codex` agent types, so `unknown` agents bypass it. This is intentional for test panes.

---

## Adding a New CLI Command

1. Create `src/tools/my-command.ts` exporting `handleMyCommand(params): Promise<ToolResult>`
2. Add route in `src/cli/router.ts`
3. Add CLI arg parsing in `src/cli/parse.ts` if needed
4. Add to `skills/help/SKILL.md` if user-facing

All tool handlers follow the same pattern:

```typescript
import { ok, err } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';

export async function handleMyCommand(params: MyParams): Promise<ToolResult> {
  if (!params.required_field) return err('Missing required_field');
  // ... do work ...
  return ok({ result: 'data' });
}
```

---

## Adding a DB Column

1. Add to `SCHEMA` string in `src/state/db.ts` (for new databases)
2. Add `ALTER TABLE ... ADD COLUMN` migration in `initDb()` after `_db.exec(SCHEMA)`:

```typescript
const cols = _db.query('PRAGMA table_info(my_table)').all() as Array<{ name: string }>;
if (!cols.some(c => c.name === 'my_new_col')) {
  _db.exec('ALTER TABLE my_table ADD COLUMN my_new_col TEXT');
}
```

3. Update TypeScript types in `src/shared/types.ts`
4. Update any `SELECT *` queries that map to typed objects

Never use `DROP TABLE` migrations in production — they destroy data. Additive-only.

---

## Common Gotchas

### `rooms` column no longer exists on `tasks` or `messages`

Both tables use `room_id INTEGER FK→rooms`. Queries that filter `WHERE room = ?` will fail silently (column not found → Bun SQLite returns empty). Use `WHERE room_id = ?` and look up the ID first.

```typescript
const room = getRoom('myroom');
if (!room) return err('Room not found');
const tasks = db.query('SELECT * FROM tasks WHERE room_id = ?').all(room.id);
```

### `agent.rooms` doesn't exist

Old API had `agent.rooms: string[]`. New API: `agent.room_id: number`, `agent.room_name: string`, `agent.room_path: string`. Web components that render room membership should use `agent.room_name`.

### Cascade deletes are real

Deleting a room removes ALL agents, messages, tasks, cursors in that room. No soft delete. This is intentional (room = project session; project gone = all data gone).

### Token usage uses `agent_id` FK, not `agent_name`

```typescript
// WRONG:
db.run('INSERT INTO token_usage (agent_name, ...) VALUES (?, ...)', [name, ...])

// CORRECT:
const agent = getAgent(name);
db.run('INSERT INTO token_usage (agent_id, ...) VALUES (?, ...)', [agent.agent_id, ...])
```

### `initDb(':memory:')` in tests — each call closes the previous DB

```typescript
// Each beforeEach call fully replaces the DB
beforeEach(() => initDb(':memory:'));  // fresh DB per test
```

Calling `getDb()` before `initDb()` throws. Always call `initDb()` in `beforeAll` or `beforeEach` before any state operations.

### `getOrCreateRoom` updates name if path matches

If a room with the same path already exists but a different name, the name is silently updated to the new value. This is intentional: room name is mutable, path is canonical.

### `join-room` name resolution

1. No name provided → `agent-{4 random chars}` generated
2. Name provided, same pane, same room → update in place (no error)
3. Name provided, different pane, same room, old pane alive → `{name}-{4 random chars}` used
4. Name provided, different pane, same room, old pane dead → takes over the name

---

## Auto-Notification Format

When a worker sends `kind ∈ {completion, error, question}`, leaders receive:

```
[system@{room}]: {worker} {kind}: "{first 200 chars of message}" [context: {pane line 1} | {pane line 2} | ...]
```

The `[context: ...]` section is the last 20 non-empty lines of the worker's pane scrollback, flattened to a single line. Falls back to message text only if worker has no pane or capture fails.

This is a fire-and-forget push — `deliverMessage` returns before the notification is delivered to the leader pane. The notification goes through the same `waitForReady` → `sendKeys` flow as regular pushes.

---

## Key File Locations

| What | Where |
|------|-------|
| Schema DDL | `src/state/db.ts` → `SCHEMA` const |
| All state reads | `src/state/index.ts` |
| All state writes | `src/state/db-write.ts` |
| Delivery logic | `src/delivery/index.ts` |
| Pane queue + ready detection | `src/delivery/pane-queue.ts` |
| tmux wrappers | `src/tmux/index.ts` |
| Tool handlers | `src/tools/*.ts` |
| CLI routing | `src/cli/router.ts` |
| REST API | `src/server/api.ts` |
| Web state polling | `src/web/src/hooks/useStateReader.ts` |
| Shared types | `src/shared/types.ts` |
| Test helpers | `test/helpers.ts` |
| Config (polling profiles, etc.) | `src/config.ts` |
