import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

let _db: Database | null = null;

const SCHEMA = `
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=5000;

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    topic TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    pane TEXT,
    agent_type TEXT NOT NULL DEFAULT 'unknown',
    registered_at TEXT NOT NULL,
    last_activity TEXT,
    status TEXT,
    persona TEXT,
    capabilities TEXT,
    UNIQUE(room_id, name)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_pane ON agents(pane) WHERE pane IS NOT NULL;

  CREATE TABLE IF NOT EXISTS messages (
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

  CREATE TABLE IF NOT EXISTS cursors (
    agent_id INTEGER PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    last_seq INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS tasks (
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

  CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    triggered_by TEXT,
    timestamp TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS token_usage (
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

  CREATE TABLE IF NOT EXISTS pricing (
    model_name TEXT PRIMARY KEY,
    input_cost_per_million REAL NOT NULL,
    output_cost_per_million REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS change_log (
    scope TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'worker',
    persona TEXT,
    capabilities TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS room_templates (
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    template_id INTEGER NOT NULL REFERENCES agent_templates(id) ON DELETE CASCADE,
    PRIMARY KEY (room_id, template_id)
  );

  CREATE TABLE IF NOT EXISTS room_template_definitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    topic TEXT,
    agent_template_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_agents_room ON agents(room_id);
  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, id);
  CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient, id);
  CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id, status);
  CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status);
  CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_id, recorded_at);

  CREATE TRIGGER IF NOT EXISTS trg_messages_change AFTER INSERT ON messages
  BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'messages'; END;

  CREATE TRIGGER IF NOT EXISTS trg_agents_change AFTER INSERT ON agents
  BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'agents'; END;

  CREATE TRIGGER IF NOT EXISTS trg_agents_update AFTER UPDATE ON agents
  BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'agents'; END;

  CREATE TRIGGER IF NOT EXISTS trg_tasks_change AFTER UPDATE ON tasks
  BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'tasks'; END;

  CREATE TRIGGER IF NOT EXISTS trg_tasks_insert AFTER INSERT ON tasks
  BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'tasks'; END;

  CREATE TRIGGER IF NOT EXISTS trg_templates_ins AFTER INSERT ON agent_templates
  BEGIN UPDATE change_log SET version=version+1, updated_at=datetime('now') WHERE scope='templates'; END;

  CREATE TRIGGER IF NOT EXISTS trg_templates_upd AFTER UPDATE ON agent_templates
  BEGIN UPDATE change_log SET version=version+1, updated_at=datetime('now') WHERE scope='templates'; END;

  CREATE TRIGGER IF NOT EXISTS trg_templates_del AFTER DELETE ON agent_templates
  BEGIN UPDATE change_log SET version=version+1, updated_at=datetime('now') WHERE scope='templates'; END;

  CREATE TRIGGER IF NOT EXISTS trg_room_tpl_ins AFTER INSERT ON room_template_definitions
  BEGIN UPDATE change_log SET version=version+1, updated_at=datetime('now') WHERE scope='room-templates'; END;

  CREATE TRIGGER IF NOT EXISTS trg_room_tpl_upd AFTER UPDATE ON room_template_definitions
  BEGIN UPDATE change_log SET version=version+1, updated_at=datetime('now') WHERE scope='room-templates'; END;

  CREATE TRIGGER IF NOT EXISTS trg_room_tpl_del AFTER DELETE ON room_template_definitions
  BEGIN UPDATE change_log SET version=version+1, updated_at=datetime('now') WHERE scope='room-templates'; END;
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

  const hasRoomsTable = Boolean(
    _db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='rooms'").get() as { name: string } | null,
  );

  if (hasRoomsTable) {
    const roomCols = _db.query('PRAGMA table_info(rooms)').all() as Array<{ name: string }>;
    const hasPathCol = roomCols.some(c => c.name === 'path');

    if (!hasPathCol) {
      console.warn('[crew] Legacy schema detected. Resetting database to room-scoped schema...');
      _db.exec(`
        PRAGMA foreign_keys=OFF;
        DROP TABLE IF EXISTS members;
        DROP TABLE IF EXISTS cursors;
        DROP TABLE IF EXISTS task_events;
        DROP TABLE IF EXISTS tasks;
        DROP TABLE IF EXISTS messages;
        DROP TABLE IF EXISTS token_usage;
        DROP TABLE IF EXISTS room_templates;
        DROP TABLE IF EXISTS agents;
        DROP TABLE IF EXISTS rooms;
        DROP TABLE IF EXISTS agent_templates;
        DROP TABLE IF EXISTS room_template_definitions;
        DROP TABLE IF EXISTS change_log;
        DROP TABLE IF EXISTS pricing;
        PRAGMA foreign_keys=ON;
      `);
    }
  }

  _db.exec(SCHEMA);

  const scopes = ['agents', 'messages', 'tasks', 'templates', 'room-templates'];
  for (const scope of scopes) {
    _db.run(
      'INSERT OR IGNORE INTO change_log (scope, version, updated_at) VALUES (?, 0, datetime("now"))',
      [scope],
    );
  }

  const defaultPricing: Array<[string, number, number]> = [
    ['claude-opus-4-6', 15.0, 75.0],
    ['claude-sonnet-4-6', 3.0, 15.0],
    ['claude-haiku-4-5-20251001', 0.8, 4.0],
    ['gpt-4.1', 2.0, 8.0],
    ['o3', 2.0, 8.0],
    ['o4-mini', 1.1, 4.4],
  ];

  for (const [model, input, output] of defaultPricing) {
    _db.run(
      'INSERT OR IGNORE INTO pricing (model_name, input_cost_per_million, output_cost_per_million) VALUES (?, ?, ?)',
      [model, input, output],
    );
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
