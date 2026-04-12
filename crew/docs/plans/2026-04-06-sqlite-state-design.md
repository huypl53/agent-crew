# SQLite State Management — Design

**Date:** 2026-04-06
**Status:** Approved

## Problem

The current approach stores state in 4 JSON files (`agents.json`, `rooms.json`, `messages.json`, `room-messages.json`) with a read-merge-write pattern. Each MCP server process (one per Claude Code session) has its own in-memory state and periodically flushes to disk.

**Core flaw:** There is an in-process `flushLock` but no cross-process lock. Two processes flushing simultaneously is a real race — the last writer wins and silently drops the other's changes. Every complexity added since (`generation` counters, dedup by `message_id`, `syncFromDisk`, merge-on-write) patches around this gap without closing it.

Additional problems:
- 4 separate files written with `Promise.all` — not atomic (inconsistent state on crash)
- ~200 lines of merge/lock/generation machinery
- Cursors lost on restart (agents re-read all messages after each restart)
- `syncFromDisk()` is additive only — newly deleted agents linger until all processes restart

## Solution: SQLite via `bun:sqlite`

Replace all 4 JSON files with a single SQLite database at `/tmp/cc-tmux/state/cc-tmux.db`. WAL mode (`PRAGMA journal_mode=WAL`) handles concurrent readers + single writer natively — the fundamental race is eliminated by the database engine.

## Schema

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE agents (
  name          TEXT PRIMARY KEY,
  role          TEXT NOT NULL,
  pane          TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  last_activity TEXT
);

CREATE TABLE rooms (
  name       TEXT PRIMARY KEY,
  topic      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE members (
  room      TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
  agent     TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (room, agent)
);

CREATE TABLE messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sender    TEXT,
  room      TEXT,
  recipient TEXT,
  text      TEXT NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'chat',
  mode      TEXT,
  timestamp TEXT NOT NULL
);

CREATE TABLE cursors (
  agent    TEXT NOT NULL,
  room     TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent, room)
);

CREATE INDEX idx_messages_room      ON messages(room, id);
CREATE INDEX idx_messages_recipient ON messages(recipient, id);
```

**Design decisions:**
- `sender`/`recipient` instead of `from`/`to` — avoids SQL reserved words; MCP tool responses alias back to `from`/`to` via `SELECT sender AS "from", recipient AS "to"`
- `message_id` dropped — was invented solely for JSON-merge dedup; autoincrement `id` is canonical; returned as `message_id` in MCP responses via column alias
- No FK on `messages.room`/`messages.sender` — messages survive agent/room deletion (history is valuable); only `members` uses CASCADE since membership is structural
- `recipient` column kept — needed for pull-mode messages (leader finding messages addressed to them specifically) and cross-room inbox queries (`SELECT ... WHERE recipient = ? AND id > ?`)
- `cursors` now persist across restarts — improvement over today where cursor loss causes full re-reads

## API Changes

Current async state functions are replaced with synchronous SQLite queries:

| Old | New |
|-----|-----|
| `await flushAsync()` | removed (every write is immediate) |
| `await syncFromDisk()` | removed (every read hits the single DB) |
| `await loadState()` | `initDb()` — opens DB, runs schema migrations |
| `addMessage(...)` | `db.run(INSERT INTO messages ...)` |
| `readRoomMessages(room, agent, filters)` | `db.query(SELECT ... WHERE room=? AND id>? AND kind IN ...)` |
| `getCursor(agent, room)` | `db.query(SELECT last_seq FROM cursors WHERE agent=? AND room=?)` |
| `advanceCursor(agent, room, seq)` | `db.run(INSERT OR REPLACE INTO cursors ...)` |

`bun:sqlite` is synchronous — every query blocks the event loop. At cc-tmux's message volumes (low hundreds per session), queries complete in microseconds. No worker threads needed.

## Dashboard Change Detection

The dashboard's `state-reader.ts` currently uses `fs.watch()` on the state directory. With SQLite:
- Use `setInterval` polling `SELECT MAX(id) FROM messages` every 500ms
- Compare against last known max — if changed, re-read state
- More predictable than `fs.watch` (which has platform quirks on Linux inotify) and ~1μs per poll

## Files Changed

| File | Change |
|------|--------|
| `src/state/index.ts` | Full rewrite — shrinks dramatically, removes ~200 lines of merge/lock machinery |
| `src/dashboard/state-reader.ts` | Rewrite: `readJson()` → `db.query()`, `fs.watch` → poll `MAX(id)` |
| `src/tools/*.ts` | Delete 6 `await syncFromDisk()` lines |
| `src/index.ts` | Remove `loadState()` → `initDb()`, remove SIGTERM flush (writes are immediate) |
| `test/state.test.ts` | Remove `flushAsync`/`clearState` machinery, simplify setup |
| `test/tools.test.ts` | Remove `clearState`, simplify setup |

| File | Unchanged |
|------|-----------|
| `src/delivery/index.ts` | Calls `addMessage` etc — already logically sync |
| `src/dashboard/render.ts` | Consumes state, doesn't read storage |
| `src/shared/types.ts` | Types unchanged |

## Migration

No backward compatibility needed. The JSON state files are ephemeral (`/tmp/`), and agents re-register on the next MCP tool call anyway. On first startup with new code, `initDb()` creates the schema; the JSON files are ignored and can be deleted.

## Trade-offs

**Loses:** `cat agents.json` for quick debugging → use `sqlite3 /tmp/cc-tmux/state/cc-tmux.db '.tables'` or `sqlite3 ... 'SELECT * FROM agents'` (sqlite3 is standard on most systems).

**Gains:** ACID transactions, no race window, persistent cursors, ~200 fewer lines, 6 fewer `await syncFromDisk()` calls, single source of truth across all processes.
