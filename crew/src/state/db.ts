import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

let _db: Database | null = null;

const SCHEMA = `
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=5000;

  CREATE TABLE IF NOT EXISTS agents (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL,
    pane          TEXT,
    agent_type    TEXT NOT NULL DEFAULT 'unknown',
    registered_at TEXT NOT NULL,
    last_activity TEXT,
    status        TEXT,
    persona       TEXT,
    capabilities  TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_pane ON agents(pane) WHERE pane IS NOT NULL;

  CREATE TABLE IF NOT EXISTS rooms (
    name       TEXT PRIMARY KEY,
    topic      TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS members (
    room      TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
    agent     TEXT NOT NULL,
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
    timestamp TEXT NOT NULL,
    reply_to  INTEGER REFERENCES messages(id)
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
    agent_name  TEXT NOT NULL UNIQUE,
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

  CREATE TABLE IF NOT EXISTS change_log (
    scope      TEXT PRIMARY KEY,
    version    INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room      ON messages(room, id);
  CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient, id);
  CREATE INDEX IF NOT EXISTS idx_tasks_assigned     ON tasks(assigned_to, status);
  CREATE INDEX IF NOT EXISTS idx_tasks_room         ON tasks(room, status);
  CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_name, recorded_at);

  CREATE TRIGGER IF NOT EXISTS trg_messages_change AFTER INSERT ON messages
  BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'messages'; END;

  CREATE TRIGGER IF NOT EXISTS trg_tasks_change AFTER UPDATE ON tasks
  BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'tasks'; END;

  CREATE TRIGGER IF NOT EXISTS trg_tasks_insert AFTER INSERT ON tasks
  BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'tasks'; END;

  CREATE TRIGGER IF NOT EXISTS trg_agents_change AFTER INSERT ON agents
  BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'agents'; END;

  CREATE TRIGGER IF NOT EXISTS trg_agents_update AFTER UPDATE ON agents
  BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'agents'; END;

  CREATE TRIGGER IF NOT EXISTS trg_agents_delete AFTER DELETE ON agents
  BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'agents'; END;

  CREATE TABLE IF NOT EXISTS agent_templates (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'worker',
    persona      TEXT,
    capabilities TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS room_templates (
    room        TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
    template_id INTEGER NOT NULL REFERENCES agent_templates(id) ON DELETE CASCADE,
    PRIMARY KEY (room, template_id)
  );

  CREATE TRIGGER IF NOT EXISTS trg_templates_ins AFTER INSERT ON agent_templates
  BEGIN UPDATE change_log SET version=version+1, updated_at=datetime('now') WHERE scope='templates'; END;

  CREATE TRIGGER IF NOT EXISTS trg_templates_upd AFTER UPDATE ON agent_templates
  BEGIN UPDATE change_log SET version=version+1, updated_at=datetime('now') WHERE scope='templates'; END;

  CREATE TRIGGER IF NOT EXISTS trg_templates_del AFTER DELETE ON agent_templates
  BEGIN UPDATE change_log SET version=version+1, updated_at=datetime('now') WHERE scope='templates'; END;

  CREATE TABLE IF NOT EXISTS room_template_definitions (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL UNIQUE,
    topic              TEXT,
    agent_template_ids TEXT NOT NULL DEFAULT '[]',
    created_at         TEXT NOT NULL
  );

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
  _db.exec(SCHEMA);

  // Migrate existing tables — ALTER TABLE for columns added after initial schema
  try { _db.exec('ALTER TABLE agents ADD COLUMN agent_type TEXT NOT NULL DEFAULT \'unknown\''); } catch { /* column already exists */ }
  try { _db.exec('ALTER TABLE tasks ADD COLUMN context TEXT'); } catch { /* column already exists */ }
  try { _db.exec('ALTER TABLE agents ADD COLUMN status TEXT'); } catch { /* column already exists */ }

  // Migrate agents: add id column (name was previously PRIMARY KEY, now id is)
  {
    const cols = _db.query('PRAGMA table_info(agents)').all() as Array<{ name: string; pk: number; notnull: number }>;
    const hasIdCol = cols.some(c => c.name === 'id');
    const nameIsPK = cols.find(c => c.name === 'name')?.pk === 1;
    const paneNotNull = cols.find(c => c.name === 'pane')?.notnull === 1;
    const hasPersona = cols.some(c => c.name === 'persona');
    const hasCapabilities = cols.some(c => c.name === 'capabilities');

    // Need full rebuild if: name is still PK (old schema) OR pane is NOT NULL (older schema)
    if (nameIsPK || paneNotNull || !hasIdCol) {
      _db.exec(`
        PRAGMA foreign_keys=OFF;
        CREATE TABLE agents_v3 (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          name          TEXT NOT NULL,
          role          TEXT NOT NULL,
          pane          TEXT,
          agent_type    TEXT NOT NULL DEFAULT 'unknown',
          registered_at TEXT NOT NULL,
          last_activity TEXT,
          status        TEXT,
          persona       TEXT,
          capabilities  TEXT
        );
        INSERT INTO agents_v3 (name, role, pane, agent_type, registered_at, last_activity, status, persona, capabilities)
          SELECT name, role, pane, agent_type, registered_at, last_activity, status,
                 ${hasPersona ? 'persona' : 'NULL'},
                 ${hasCapabilities ? 'capabilities' : 'NULL'}
          FROM agents;
        DROP TABLE agents;
        ALTER TABLE agents_v3 RENAME TO agents;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_pane ON agents(pane) WHERE pane IS NOT NULL;
        PRAGMA foreign_keys=ON;
      `);
      // Recreate triggers dropped with the old table
      _db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_agents_change AFTER INSERT ON agents
        BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'agents'; END;
        CREATE TRIGGER IF NOT EXISTS trg_agents_update AFTER UPDATE ON agents
        BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'agents'; END;
        CREATE TRIGGER IF NOT EXISTS trg_agents_delete AFTER DELETE ON agents
        BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'agents'; END;
      `);
      // Remove FK constraint from members (name is no longer unique)
      const membersCols = _db.query('PRAGMA table_info(members)').all() as Array<{ name: string }>;
      if (membersCols.length > 0) {
        _db.exec(`
          CREATE TABLE IF NOT EXISTS members_v2 (
            room      TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
            agent     TEXT NOT NULL,
            joined_at TEXT NOT NULL,
            PRIMARY KEY (room, agent)
          );
          INSERT OR IGNORE INTO members_v2 SELECT * FROM members;
          DROP TABLE members;
          ALTER TABLE members_v2 RENAME TO members;
        `);
      }
    } else {
      if (!hasPersona) try { _db.exec('ALTER TABLE agents ADD COLUMN persona TEXT'); } catch { /* exists */ }
      if (!hasCapabilities) try { _db.exec('ALTER TABLE agents ADD COLUMN capabilities TEXT'); } catch { /* exists */ }
    }
  }

  // Migrate messages: add reply_to column
  try { _db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER REFERENCES messages(id)'); } catch { /* column already exists */ }

  // Migrate token_usage: dedupe to one row per agent (fix unbounded growth)
  try {
    const hasUnique = (_db.query(
      "SELECT COUNT(*) as cnt FROM pragma_index_list('token_usage') WHERE origin='u'"
    ).get() as any)?.cnt > 0;
    if (!hasUnique) {
      _db.exec(`
        CREATE TABLE IF NOT EXISTS token_usage_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_name    TEXT NOT NULL UNIQUE,
          session_id    TEXT,
          model         TEXT,
          input_tokens  INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd      REAL,
          source        TEXT NOT NULL DEFAULT 'statusline',
          recorded_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO token_usage_new (agent_name, session_id, model, input_tokens, output_tokens, cost_usd, source, recorded_at)
          SELECT agent_name, session_id, model, input_tokens, output_tokens, cost_usd, source, recorded_at
          FROM token_usage t1
          WHERE recorded_at = (SELECT MAX(recorded_at) FROM token_usage t2 WHERE t2.agent_name = t1.agent_name);
        DROP TABLE token_usage;
        ALTER TABLE token_usage_new RENAME TO token_usage;
        CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_name, recorded_at);
      `);
    }
  } catch { /* brand-new DB or already migrated */ }

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

  // Migrate: ensure agent_templates and room_templates exist on older DBs
  _db.exec(`CREATE TABLE IF NOT EXISTS agent_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'worker', persona TEXT, capabilities TEXT, created_at TEXT NOT NULL
  )`);
  _db.exec(`CREATE TABLE IF NOT EXISTS room_templates (
    room TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
    template_id INTEGER NOT NULL REFERENCES agent_templates(id) ON DELETE CASCADE,
    PRIMARY KEY (room, template_id)
  )`);
  try { _db.exec("INSERT OR IGNORE INTO change_log (scope,version,updated_at) VALUES ('templates',0,datetime('now'))"); } catch { /* exists */ }

  // Migrate: ensure room_template_definitions exists on older DBs
  _db.exec(`CREATE TABLE IF NOT EXISTS room_template_definitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
    topic TEXT, agent_template_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
  )`);
  try { _db.exec("INSERT OR IGNORE INTO change_log (scope,version,updated_at) VALUES ('room-templates',0,datetime('now'))"); } catch { /* exists */ }

  // Initialize change_log with scopes
  _db.exec(`
    INSERT OR IGNORE INTO change_log (scope, version, updated_at) VALUES ('messages', 0, datetime('now'));
    INSERT OR IGNORE INTO change_log (scope, version, updated_at) VALUES ('tasks', 0, datetime('now'));
    INSERT OR IGNORE INTO change_log (scope, version, updated_at) VALUES ('agents', 0, datetime('now'));
    INSERT OR IGNORE INTO change_log (scope, version, updated_at) VALUES ('templates', 0, datetime('now'));
    INSERT OR IGNORE INTO change_log (scope, version, updated_at) VALUES ('room-templates', 0, datetime('now'));
  `);
}

export function getDb(): Database {
  if (!_db) throw new Error('DB not initialized — call initDb() first');
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
