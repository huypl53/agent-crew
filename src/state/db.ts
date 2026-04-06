import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

let _db: Database | null = null;

const SCHEMA = `
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=5000;

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
  if (_db) { _db.close(); _db = null; }
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
