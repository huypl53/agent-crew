# SQLite State Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace 4 JSON files + in-memory Maps + read-merge-write machinery with a single SQLite database, eliminating the cross-process race condition and ~200 lines of merge/flush code.

**Architecture:** A new `src/state/db.ts` module owns the `Database` instance and schema DDL. All state operations in `src/state/index.ts` become direct synchronous SQLite queries. The dashboard polls `SELECT MAX(id)` instead of using `fs.watch`. Tests use `:memory:` databases, eliminating the temp-dir isolation dance.

**Tech Stack:** `bun:sqlite` (built into Bun, no install needed), WAL journal mode for concurrent multi-process reads, autoincrement `id` replaces both `message_id` and `sequence`.

**Design doc:** `docs/plans/2026-04-06-sqlite-state-design.md`

---

### Task 1: DB module — schema and init

**Files:**
- Create: `src/state/db.ts`
- Modify: `test/state.test.ts` (add DB init/teardown, remove CC_TMUX_STATE_DIR hack)

**Step 1: Write the failing test**

Replace the top of `test/state.test.ts` with:

```ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { initDb, closeDb } from '../src/state/db.ts';
import {
  addAgent, getAgent, removeAgent, removeAgentFully,
  getRoom, getAllRooms, getRoomMembers, isNameTakenInRoom,
  addMessage, readMessages, getRoomMessages,
  getCursor, advanceCursor, readRoomMessages, clearState,
} from '../src/state/index.ts';

describe('state module', () => {
  beforeEach(() => { initDb(':memory:'); });
  afterEach(() => { closeDb(); });
  // ... existing tests unchanged below
```

**Step 2: Run to confirm it fails**

```bash
bun test test/state.test.ts 2>&1 | head -20
```

Expected: `Cannot find module '../src/state/db.ts'`

**Step 3: Create `src/state/db.ts`**

```ts
import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

let _db: Database | null = null;

const SCHEMA = `
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;

  CREATE TABLE IF NOT EXISTS agents (
    name          TEXT PRIMARY KEY,
    role          TEXT NOT NULL,
    pane          TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    last_activity TEXT
  );

  CREATE TABLE IF NOT EXISTS rooms (
    name       TEXT PRIMARY KEY,
    topic      TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS members (
    room      TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
    agent     TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (room, agent)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    sender    TEXT,
    room      TEXT,
    recipient TEXT,
    text      TEXT NOT NULL,
    kind      TEXT NOT NULL DEFAULT 'chat',
    mode      TEXT,
    timestamp TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cursors (
    agent    TEXT NOT NULL,
    room     TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (agent, room)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room      ON messages(room, id);
  CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient, id);
`;

export function getDbPath(): string {
  const stateDir = process.env.CC_TMUX_STATE_DIR ?? '/tmp/cc-tmux/state';
  return `${stateDir}/cc-tmux.db`;
}

export function initDb(path?: string): void {
  const dbPath = path ?? getDbPath();
  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  _db = new Database(dbPath, { create: true });
  _db.exec(SCHEMA);
}

export function getDb(): Database {
  if (!_db) throw new Error('DB not initialized — call initDb() first');
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
```

**Step 4: Run test again**

```bash
bun test test/state.test.ts 2>&1 | head -20
```

Expected: DB module loads but state functions fail (not yet rewritten).

**Step 5: Commit**

```bash
git add src/state/db.ts
git commit -m "feat: add SQLite db module with schema"
```

---

### Task 2: Rewrite state module — agents and rooms

**Files:**
- Modify: `src/state/index.ts` (full rewrite — agents/rooms section)

**Step 1: Replace `src/state/index.ts` agents/rooms section**

Replace the entire file with the following (messages/cursor sections come next task):

```ts
import type { Agent, AgentRole, Room, Message, MessageKind } from '../shared/types.ts';
import { isPaneDead } from '../tmux/index.ts';
import { getDb, initDb, closeDb, getDbPath } from './db.ts';

// Re-export for callers that currently import these
export { initDb, closeDb };

// --- Helpers ---

function now(): string { return new Date().toISOString(); }

function dbAgentToAgent(row: Record<string, unknown>, rooms: string[]): Agent {
  return {
    agent_id: row.name as string,
    name: row.name as string,
    role: row.role as AgentRole,
    rooms,
    tmux_target: row.pane as string,
    joined_at: row.registered_at as string,
    last_activity: row.last_activity as string | undefined,
  };
}

function dbRoomToRoom(row: Record<string, unknown>, members: string[]): Room {
  return {
    name: row.name as string,
    members,
    topic: row.topic as string | undefined,
    created_at: row.created_at as string,
  };
}

// --- Agent operations ---

export function getAgent(name: string): Agent | undefined {
  const db = getDb();
  const row = db.query('SELECT * FROM agents WHERE name = ?').get(name) as Record<string, unknown> | null;
  if (!row) return undefined;
  const rooms = (db.query('SELECT room FROM members WHERE agent = ?').all(name) as { room: string }[]).map(r => r.room);
  return dbAgentToAgent(row, rooms);
}

export function getAllAgents(): Agent[] {
  const db = getDb();
  const rows = db.query('SELECT * FROM agents').all() as Record<string, unknown>[];
  return rows.map(row => {
    const rooms = (db.query('SELECT room FROM members WHERE agent = ?').all(row.name) as { room: string }[]).map(r => r.room);
    return dbAgentToAgent(row, rooms);
  });
}

export function addAgent(name: string, role: AgentRole, room: string, tmuxTarget: string): Agent {
  const db = getDb();
  const ts = now();

  db.run(
    `INSERT INTO agents (name, role, pane, registered_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET pane = excluded.pane`,
    [name, role, tmuxTarget, ts],
  );

  db.run(
    'INSERT OR IGNORE INTO rooms (name, created_at) VALUES (?, ?)',
    [room, ts],
  );

  db.run(
    'INSERT OR IGNORE INTO members (room, agent, joined_at) VALUES (?, ?, ?)',
    [room, name, ts],
  );

  return getAgent(name)!;
}

export function removeAgent(name: string, room: string): boolean {
  const db = getDb();
  const changes = db.run('DELETE FROM members WHERE room = ? AND agent = ?', [room, name]).changes;
  if (changes === 0) return false;

  // Delete room if empty
  const count = (db.query('SELECT COUNT(*) as c FROM members WHERE room = ?').get(room) as { c: number }).c;
  if (count === 0) db.run('DELETE FROM rooms WHERE name = ?', [room]);

  // Delete agent if no rooms left
  const agentRooms = (db.query('SELECT COUNT(*) as c FROM members WHERE agent = ?').get(name) as { c: number }).c;
  if (agentRooms === 0) db.run('DELETE FROM agents WHERE name = ?', [name]);

  return true;
}

export function removeAgentFully(name: string): void {
  // CASCADE on members table handles membership cleanup
  getDb().run('DELETE FROM agents WHERE name = ?', [name]);
}

// --- Room operations ---

export function getRoom(name: string): Room | undefined {
  const db = getDb();
  const row = db.query('SELECT * FROM rooms WHERE name = ?').get(name) as Record<string, unknown> | null;
  if (!row) return undefined;
  const members = (db.query('SELECT agent FROM members WHERE room = ?').all(name) as { agent: string }[]).map(r => r.agent);
  return dbRoomToRoom(row, members);
}

export function getAllRooms(): Room[] {
  const db = getDb();
  const rows = db.query('SELECT * FROM rooms').all() as Record<string, unknown>[];
  return rows.map(row => {
    const members = (db.query('SELECT agent FROM members WHERE room = ?').all(row.name) as { agent: string }[]).map(r => r.agent);
    return dbRoomToRoom(row, members);
  });
}

export function getRoomMembers(room: string): Agent[] {
  const db = getDb();
  const rows = db.query(
    'SELECT a.* FROM agents a JOIN members m ON m.agent = a.name WHERE m.room = ?',
  ).all(room) as Record<string, unknown>[];
  return rows.map(row => {
    const rooms = (db.query('SELECT room FROM members WHERE agent = ?').all(row.name) as { room: string }[]).map(r => r.room);
    return dbAgentToAgent(row, rooms);
  });
}

export function setRoomTopic(roomName: string, topic: string): boolean {
  const changes = getDb().run('UPDATE rooms SET topic = ? WHERE name = ?', [topic, roomName]).changes;
  return changes > 0;
}

export function isNameTakenInRoom(name: string, room: string): boolean {
  const row = getDb().query('SELECT 1 FROM members WHERE room = ? AND agent = ?').get(room, name);
  return row !== null;
}

// --- Message helpers ---

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    message_id: String(row.id),
    from: row.sender as string,
    room: row.room as string,
    to: row.recipient as string | null,
    text: row.text as string,
    kind: row.kind as MessageKind,
    timestamp: row.timestamp as string,
    sequence: row.id as number,
    mode: row.mode as 'push' | 'pull',
  };
}

// --- Message operations ---

export function addMessage(
  _to: string,
  from: string,
  room: string,
  text: string,
  mode: 'push' | 'pull',
  targetName: string | null,
  kind: MessageKind = 'chat',
): Message {
  const db = getDb();
  const stmt = db.run(
    'INSERT INTO messages (sender, room, recipient, text, kind, mode, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [from, room, targetName, text, kind, mode, now()],
  );
  const row = db.query('SELECT * FROM messages WHERE id = ?').get(stmt.lastInsertRowid) as Record<string, unknown>;
  return rowToMessage(row);
}

export function getRoomMessages(room: string, sinceSequence?: number, limit?: number): Message[] {
  const db = getDb();
  let sql = 'SELECT * FROM messages WHERE room = ?';
  const params: unknown[] = [room];
  if (sinceSequence !== undefined) { sql += ' AND id > ?'; params.push(sinceSequence); }
  sql += ' ORDER BY id';
  if (limit) { sql += ' LIMIT ?'; params.push(limit); }
  return (db.query(sql).all(...params) as Record<string, unknown>[]).map(rowToMessage);
}

export function getCursor(agentName: string, room: string): number {
  const row = getDb().query('SELECT last_seq FROM cursors WHERE agent = ? AND room = ?').get(agentName, room) as { last_seq: number } | null;
  return row?.last_seq ?? 0;
}

export function advanceCursor(agentName: string, room: string, sequence: number): void {
  const current = getCursor(agentName, room);
  if (sequence > current) {
    getDb().run(
      'INSERT OR REPLACE INTO cursors (agent, room, last_seq) VALUES (?, ?, ?)',
      [agentName, room, sequence],
    );
  }
}

export function readRoomMessages(
  agentName: string,
  room: string,
  kinds?: string[],
  limit = 50,
): { messages: Message[]; next_sequence: number } {
  const db = getDb();
  const cursor = getCursor(agentName, room);
  let sql = 'SELECT * FROM messages WHERE room = ? AND id > ?';
  const params: unknown[] = [room, cursor];
  if (kinds && kinds.length > 0) {
    sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }
  sql += ` ORDER BY id DESC LIMIT ?`;
  params.push(limit);

  // Reverse back to chronological order
  const msgs = (db.query(sql).all(...params) as Record<string, unknown>[]).map(rowToMessage).reverse();
  const maxSeq = msgs.length > 0 ? msgs[msgs.length - 1]!.sequence : cursor;
  advanceCursor(agentName, room, maxSeq);
  return { messages: msgs, next_sequence: maxSeq };
}

export function readMessages(
  agentName: string,
  room?: string,
  sinceSequence?: number,
): { messages: Message[]; next_sequence: number } {
  const db = getDb();
  let sql = 'SELECT * FROM messages WHERE recipient = ?';
  const params: unknown[] = [agentName];
  if (room) { sql += ' AND room = ?'; params.push(room); }
  if (sinceSequence !== undefined) { sql += ' AND id > ?'; params.push(sinceSequence); }
  sql += ' ORDER BY id';
  const msgs = (db.query(sql).all(...params) as Record<string, unknown>[]).map(rowToMessage);
  const maxSeq = msgs.length > 0 ? msgs[msgs.length - 1]!.sequence : sinceSequence ?? 0;
  return { messages: msgs, next_sequence: maxSeq };
}

export function getAllMessages(): Message[] {
  return (getDb().query('SELECT * FROM messages ORDER BY id').all() as Record<string, unknown>[]).map(rowToMessage);
}

// --- Liveness ---

export async function validateLiveness(): Promise<string[]> {
  const dead: string[] = [];
  for (const agent of getAllAgents()) {
    if (await isPaneDead(agent.tmux_target)) {
      removeAgentFully(agent.name);
      dead.push(agent.name);
    }
  }
  return dead;
}

// --- Test helpers ---

export function clearState(): void {
  const db = getDb();
  db.exec('DELETE FROM messages; DELETE FROM members; DELETE FROM rooms; DELETE FROM agents; DELETE FROM cursors;');
}

// --- Deprecated stubs (removed, callers must be updated) ---
// syncFromDisk() — deleted, every read hits DB directly
// flushAsync()   — deleted, every write is immediate
// loadState()    — replaced by initDb() in src/state/db.ts
```

**Step 2: Run tests**

```bash
bun test test/state.test.ts 2>&1 | tail -30
```

Expected: most tests pass; some may fail if they test the old inbox dedup or `message_id` string format.

**Step 3: Fix `message_id` assertion if present**

If tests check `msg.message_id` format (e.g. `msg-...`), update them to accept a numeric string:
```ts
// Old:
expect(msg.message_id).toMatch(/^msg-/);
// New:
expect(Number(msg.message_id)).toBeGreaterThan(0);
```

**Step 4: Run tests until green**

```bash
bun test test/state.test.ts
```

Expected: all pass

**Step 5: Commit**

```bash
git add src/state/index.ts
git commit -m "feat: rewrite state module with SQLite — eliminate merge/flush machinery"
```

---

### Task 3: Update `src/index.ts` — swap loadState → initDb, remove flush

**Files:**
- Modify: `src/index.ts`

**Step 1: Update the import and startup block**

Change line 8:
```ts
// Before:
import { loadState, validateLiveness, flushAsync } from './state/index.ts';

// After:
import { validateLiveness } from './state/index.ts';
import { initDb } from './state/db.ts';
```

Change the startup block (lines 27–31):
```ts
// Before:
await loadState();
const deadAgents = await validateLiveness();

// After:
initDb();
const deadAgents = await validateLiveness();
```

Remove the shutdown handler (lines 172–178):
```ts
// Delete entirely — writes are immediate, no flush needed:
async function shutdown(): Promise<void> {
  await flushAsync();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

**Step 2: Verify it compiles**

```bash
bun build src/index.ts --target bun 2>&1 | head -20
```

Expected: no errors

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "fix: swap loadState for initDb, remove flush-on-shutdown"
```

---

### Task 4: Strip `syncFromDisk` from all tools

**Files:**
- Modify: `src/tools/get-status.ts`
- Modify: `src/tools/list-members.ts`
- Modify: `src/tools/list-rooms.ts`
- Modify: `src/tools/read-messages.ts`
- Modify: `src/tools/send-message.ts`
- Modify: `src/tools/set-room-topic.ts`

Each file has the same two-line pattern to remove. For each file:

**Step 1: Remove import and call**

`get-status.ts` — change:
```ts
// Before:
import { getAgent, syncFromDisk } from '../state/index.ts';
// ...
await syncFromDisk();

// After:
import { getAgent } from '../state/index.ts';
// (delete the syncFromDisk() call line)
```

Repeat the same for `list-members.ts`, `list-rooms.ts`, `read-messages.ts`, `send-message.ts`, `set-room-topic.ts`.

**Step 2: Run tool tests**

```bash
bun test test/tools.test.ts 2>&1 | head -30
```

Expected: `clearState` still works (it's defined in new state module), tools no longer call syncFromDisk.

**Step 3: Fix tools test setup**

Replace the top of `test/tools.test.ts`:
```ts
// Before:
process.env.CC_TMUX_STATE_DIR = '/tmp/cc-tmux/test-state';
// ... imports ...
import { clearState } from '../src/state/index.ts';

// After:
import { initDb, closeDb } from '../src/state/db.ts';
import { clearState } from '../src/state/index.ts';
// ... other imports ...
```

And update `beforeEach`:
```ts
// Before:
beforeEach(async () => {
  clearState();
  // ...
});

// After:
beforeEach(async () => {
  initDb(':memory:');
  // ...
});

afterAll(async () => {
  await cleanupAllTestSessions();
  closeDb();
});
```

**Step 4: Run all tests**

```bash
bun test 2>&1 | tail -20
```

Expected: all tests pass

**Step 5: Commit**

```bash
git add src/tools/get-status.ts src/tools/list-members.ts src/tools/list-rooms.ts \
        src/tools/read-messages.ts src/tools/send-message.ts src/tools/set-room-topic.ts \
        test/tools.test.ts test/state.test.ts
git commit -m "fix: remove syncFromDisk calls from tools, migrate tests to :memory: DB"
```

---

### Task 5: Rewrite dashboard state reader

**Files:**
- Modify: `src/dashboard/state-reader.ts`

**Step 1: Rewrite `src/dashboard/state-reader.ts`**

```ts
import type { Agent, Room, Message } from '../shared/types.ts';
import { Database } from 'bun:sqlite';

const DB_PATH = `${process.env.CC_TMUX_STATE_DIR ?? '/tmp/cc-tmux/state'}/cc-tmux.db`;
const POLL_MS = 500;

export interface DashboardState {
  agents: Record<string, Agent>;
  rooms: Record<string, Room>;
  messages: Message[];
}

export type StateChangeHandler = (state: DashboardState) => void;

export class StateReader {
  private db: Database | null = null;
  private state: DashboardState = { agents: {}, rooms: {}, messages: [] };
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onChange: StateChangeHandler | null = null;
  private lastMaxId = 0;
  private stateExists = false;

  get current(): DashboardState { return this.state; }
  get isAvailable(): boolean { return this.stateExists; }

  async init(): Promise<DashboardState> {
    this.tryOpenDb();
    this.startPolling();
    return this.state;
  }

  setChangeHandler(handler: StateChangeHandler): void {
    this.onChange = handler;
  }

  private tryOpenDb(): void {
    try {
      this.db = new Database(DB_PATH, { readonly: true, create: false });
      this.readAll();
      this.stateExists = true;
    } catch {
      this.stateExists = false;
    }
  }

  private readAll(): void {
    if (!this.db) return;
    try {
      const agentRows = this.db.query(
        'SELECT a.*, GROUP_CONCAT(m.room) as rooms_csv FROM agents a LEFT JOIN members m ON m.agent = a.name GROUP BY a.name'
      ).all() as any[];

      const roomRows = this.db.query(
        'SELECT r.*, GROUP_CONCAT(m.agent) as members_csv FROM rooms r LEFT JOIN members m ON m.room = r.name GROUP BY r.name'
      ).all() as any[];

      const msgRows = this.db.query(
        'SELECT * FROM messages ORDER BY id DESC LIMIT 200'
      ).all() as any[];

      const agents: Record<string, Agent> = {};
      for (const row of agentRows) {
        agents[row.name] = {
          agent_id: row.name,
          name: row.name,
          role: row.role,
          rooms: row.rooms_csv ? row.rooms_csv.split(',') : [],
          tmux_target: row.pane,
          joined_at: row.registered_at,
          last_activity: row.last_activity ?? undefined,
        };
      }

      const rooms: Record<string, Room> = {};
      for (const row of roomRows) {
        rooms[row.name] = {
          name: row.name,
          members: row.members_csv ? row.members_csv.split(',') : [],
          topic: row.topic ?? undefined,
          created_at: row.created_at,
        };
      }

      const messages: Message[] = msgRows.reverse().map(row => ({
        message_id: String(row.id),
        from: row.sender,
        room: row.room,
        to: row.recipient ?? null,
        text: row.text,
        kind: row.kind,
        timestamp: row.timestamp,
        sequence: row.id,
        mode: row.mode,
      }));

      this.state = { agents, rooms, messages };
    } catch {
      // DB may be mid-write; skip this tick
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      if (!this.db) {
        this.tryOpenDb();
        if (this.stateExists) this.onChange?.(this.state);
        return;
      }
      try {
        const row = this.db.query('SELECT MAX(id) as max FROM messages').get() as { max: number | null };
        const maxId = row?.max ?? 0;
        if (maxId !== this.lastMaxId) {
          this.lastMaxId = maxId;
          this.readAll();
          this.onChange?.(this.state);
        }
      } catch {
        // DB gone (MCP server stopped) — close and retry next tick
        this.db?.close();
        this.db = null;
        this.stateExists = false;
      }
    }, POLL_MS);
  }

  stop(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.db?.close();
    this.db = null;
  }
}
```

**Step 2: Build-check dashboard entry point**

```bash
bun build src/dashboard/index.ts --target bun 2>&1 | head -20
```

Expected: no errors

**Step 3: Commit**

```bash
git add src/dashboard/state-reader.ts
git commit -m "feat: dashboard reads from SQLite, polls MAX(id) instead of fs.watch"
```

---

### Task 6: Run full test suite and final verification

**Step 1: Run all tests**

```bash
bun test 2>&1
```

Expected: all tests pass, no errors

**Step 2: Smoke test — start MCP server and verify DB is created**

```bash
# Start server briefly in background
timeout 3 bun src/index.ts 2>&1 || true
ls -lh /tmp/cc-tmux/state/
```

Expected: `cc-tmux.db` file exists, old JSON files either absent or ignored

**Step 3: Verify old JSON files are no longer written**

```bash
# Remove old files
rm -f /tmp/cc-tmux/state/*.json
# Start server again briefly
timeout 3 bun src/index.ts 2>&1 || true
ls /tmp/cc-tmux/state/
```

Expected: only `cc-tmux.db` (and WAL sidecar `cc-tmux.db-wal`, `cc-tmux.db-shm`), no JSON files

**Step 4: Commit any leftover cleanup**

```bash
bun test
git add -A
git commit -m "chore: clean up post-SQLite migration"
```

---

### Task 7: Update docs

**Files:**
- Modify: `docs/architecture.md`
- Modify: `README.md`

**Step 1: Update architecture.md**

In the state management section, replace the JSON + merge-on-write description with:

- State stored in `${CC_TMUX_STATE_DIR}/cc-tmux.db` (default `/tmp/cc-tmux/state/cc-tmux.db`)
- WAL mode — multiple processes read concurrently, SQLite serializes writes atomically
- Dashboard polls `SELECT MAX(id) FROM messages` every 500ms for change detection
- Cursors are now persistent across MCP server restarts
- Debug: `sqlite3 /tmp/cc-tmux/state/cc-tmux.db '.tables'` or `SELECT * FROM agents;`

**Step 2: Update README.md debug section if present**

Replace any reference to `cat agents.json` / `cat rooms.json` with sqlite3 commands.

**Step 3: Commit**

```bash
git add docs/architecture.md README.md
git commit -m "docs: update state management docs for SQLite migration"
```
