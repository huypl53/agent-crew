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
    agent_type    TEXT NOT NULL DEFAULT 'unknown',
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

  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    room        TEXT NOT NULL,
    assigned_to TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    message_id  INTEGER,
    summary     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'sent',
    note        TEXT,
    context     TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id      INTEGER NOT NULL,
    from_status  TEXT,
    to_status    TEXT NOT NULL,
    triggered_by TEXT,
    timestamp    TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );

  CREATE TABLE IF NOT EXISTS token_usage (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name  TEXT NOT NULL,
    session_id  TEXT,
    model       TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd    REAL,
    source      TEXT NOT NULL DEFAULT 'statusline',
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pricing (
    model_name            TEXT PRIMARY KEY,
    input_cost_per_million  REAL NOT NULL,
    output_cost_per_million REAL NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room      ON messages(room, id);
  CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient, id);
  CREATE INDEX IF NOT EXISTS idx_tasks_assigned     ON tasks(assigned_to, status);
  CREATE INDEX IF NOT EXISTS idx_tasks_room         ON tasks(room, status);
  CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_name, recorded_at);
`;

export function getDbPath(): string {
  const stateDir = process.env.CREW_STATE_DIR ?? '/tmp/crew/state';
  return `${stateDir}/crew.db`;
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

  // Migrate existing tables — ALTER TABLE for columns added after initial schema
  try { _db.exec('ALTER TABLE agents ADD COLUMN agent_type TEXT NOT NULL DEFAULT \'unknown\''); } catch { /* column already exists */ }

  // Insert default pricing
  const DEFAULT_PRICING = [
    ['claude-opus-4-6', 15.0, 75.0],
    ['claude-sonnet-4-6', 3.0, 15.0],
    ['claude-haiku-4-5-20251001', 0.80, 4.0],
    ['gpt-4.1', 2.0, 8.0],
    ['o3', 2.0, 8.0],
    ['o4-mini', 1.10, 4.40],
  ];

  const insertPricing = _db.prepare(
    'INSERT OR IGNORE INTO pricing (model_name, input_cost_per_million, output_cost_per_million) VALUES (?, ?, ?)'
  );
  for (const [model, inp, out] of DEFAULT_PRICING) {
    insertPricing.run(model, inp, out);
  }
}

export function getDb(): Database {
  if (!_db) throw new Error('DB not initialized — call initDb() first');
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
