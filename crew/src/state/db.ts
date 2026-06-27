import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
    reminder_policy TEXT,
    reminder_dispatch_count INTEGER NOT NULL DEFAULT 0,
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
    input_block_mode TEXT NOT NULL DEFAULT 'off',
    persona TEXT,
    capabilities TEXT,
    reminder_policy TEXT,
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
    reply_to INTEGER REFERENCES messages(id),
    batch_id TEXT,
    worker_name TEXT,
    prompt_file TEXT,
    manifest_order INTEGER
  );

  CREATE TABLE IF NOT EXISTS message_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL UNIQUE,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    leader_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    hint_after_seconds INTEGER,
    hint_sent_at TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS message_batch_workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL REFERENCES message_batches(batch_id) ON DELETE CASCADE,
    worker_name TEXT NOT NULL,
    manifest_order INTEGER NOT NULL,
    prompt_file TEXT NOT NULL,
    dispatch_status TEXT NOT NULL DEFAULT 'pending',
    terminal_status TEXT NOT NULL DEFAULT 'running',
    final_message TEXT,
    error_text TEXT,
    started_at TEXT,
    finished_at TEXT,
    UNIQUE(batch_id, worker_name)
  );

  CREATE INDEX IF NOT EXISTS idx_message_batches_room ON message_batches(room_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_message_batch_workers_batch_order ON message_batch_workers(batch_id, manifest_order);
  CREATE INDEX IF NOT EXISTS idx_message_batch_workers_terminal ON message_batch_workers(batch_id, terminal_status);

  CREATE TABLE IF NOT EXISTS cursors (
    agent_id INTEGER PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    last_seq INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS push_cursors (
    agent_id INTEGER PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    last_seq INTEGER NOT NULL DEFAULT 0
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

  CREATE TABLE IF NOT EXISTS sweep_control (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    delivery_paused INTEGER NOT NULL DEFAULT 0,
    pause_reason TEXT,
    busy_mode TEXT NOT NULL DEFAULT 'auto',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'worker',
    persona TEXT,
    capabilities TEXT,
    start_command TEXT NOT NULL DEFAULT 'claude',
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
  CREATE TABLE IF NOT EXISTS hook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    session_id TEXT,
    payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_hook_events_agent ON hook_events(agent_name);
  CREATE INDEX IF NOT EXISTS idx_hook_events_type ON hook_events(agent_name, event_type);
  CREATE INDEX IF NOT EXISTS idx_hook_events_session ON hook_events(session_id) WHERE session_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS agent_session_bindings (
    agent_name TEXT NOT NULL,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    pane TEXT,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (session_id, room_id),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_agent_session_bindings_agent_room
    ON agent_session_bindings(agent_name, room_id);
  CREATE INDEX IF NOT EXISTS idx_agent_session_bindings_session
    ON agent_session_bindings(session_id, last_seen_at);


  CREATE TRIGGER IF NOT EXISTS trg_hook_events_insert AFTER INSERT ON hook_events
  BEGIN
    INSERT INTO change_log(scope, version, updated_at) VALUES('hook-events', 1, datetime('now'))
    ON CONFLICT(scope) DO UPDATE SET version = version + 1, updated_at = datetime('now');
  END;

  CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_id, recorded_at);

  CREATE TRIGGER IF NOT EXISTS trg_messages_change AFTER INSERT ON messages
  BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'messages'; END;

  CREATE TRIGGER IF NOT EXISTS trg_agents_change AFTER INSERT ON agents
  BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'agents'; END;

  CREATE TRIGGER IF NOT EXISTS trg_agents_update AFTER UPDATE ON agents
  BEGIN UPDATE change_log SET version = version + 1, updated_at = datetime('now') WHERE scope = 'agents'; END;

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

export function getDbPath(cwd?: string): string {
  // Explicit override always wins — used by tests and per-project isolation.
  if (process.env.CREW_STATE_DIR) {
    return `${process.env.CREW_STATE_DIR}/crew.db`;
  }
  // Global DB by default so agents across different cwds share one state
  // and can collaborate in the same room. `cwd` is accepted for API compat
  // but no longer scopes the DB per project.
  void cwd;
  const stateBase =
    process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(stateBase, 'crew', 'crew.db');
}

// Track which DB path the current handle is connected to.
let _dbPath: string | null = null;

export function getActiveDbPath(): string | null {
  return _dbPath;
}

export function initDb(path?: string): void {
  const dbPath = path ?? getDbPath();

  // Always reset the connection so test setup can start from a clean state.
  // This still closes the previous handle before reopening the same path.
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
  }

  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  _db = new Database(dbPath, { create: true });
  // Set busy_timeout BEFORE any schema operations so concurrent
  // writers are tolerated (WAL allows one writer + many readers).
  _db.exec('PRAGMA busy_timeout=5000;');
  _db.exec('PRAGMA journal_mode=WAL;');
  _dbPath = dbPath;

  const hasRoomsTable = Boolean(
    _db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='rooms'",
      )
      .get() as { name: string } | null,
  );

  if (hasRoomsTable) {
    const roomCols = _db.query('PRAGMA table_info(rooms)').all() as Array<{
      name: string;
    }>;
    const hasPathCol = roomCols.some((c) => c.name === 'path');

    if (!hasPathCol) {
      console.warn(
        '[crew] Legacy schema detected. Resetting database to room-scoped schema...',
      );
      _db.exec(`
        PRAGMA foreign_keys=OFF;
        DROP TABLE IF EXISTS members;
        DROP TABLE IF EXISTS cursors;
        DROP TABLE IF EXISTS push_cursors;
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

  const messageCols = _db.query('PRAGMA table_info(messages)').all() as Array<{
    name: string;
  }>;
  if (!messageCols.some((c) => c.name === 'batch_id')) {
    _db.exec('ALTER TABLE messages ADD COLUMN batch_id TEXT');
  }
  if (!messageCols.some((c) => c.name === 'worker_name')) {
    _db.exec('ALTER TABLE messages ADD COLUMN worker_name TEXT');
  }
  if (!messageCols.some((c) => c.name === 'prompt_file')) {
    _db.exec('ALTER TABLE messages ADD COLUMN prompt_file TEXT');
  }
  if (!messageCols.some((c) => c.name === 'manifest_order')) {
    _db.exec('ALTER TABLE messages ADD COLUMN manifest_order INTEGER');
  }

  _db.exec(`
    DROP TRIGGER IF EXISTS trg_tasks_change;
    DROP TRIGGER IF EXISTS trg_tasks_insert;
    DROP TABLE IF EXISTS task_events;
    DROP TABLE IF EXISTS tasks;
    DELETE FROM change_log WHERE scope = 'tasks';
  `);

  const tplCols = _db
    .query('PRAGMA table_info(agent_templates)')
    .all() as Array<{
    name: string;
  }>;
  if (!tplCols.some((c) => c.name === 'start_command')) {
    _db.exec(
      "ALTER TABLE agent_templates ADD COLUMN start_command TEXT NOT NULL DEFAULT 'claude'",
    );
  }

  const agentCols = _db.query('PRAGMA table_info(agents)').all() as Array<{
    name: string;
  }>;
  if (!agentCols.some((c) => c.name === 'reminder_policy')) {
    _db.exec('ALTER TABLE agents ADD COLUMN reminder_policy TEXT');
  }
  if (!agentCols.some((c) => c.name === 'idle_muted')) {
    _db.exec(
      'ALTER TABLE agents ADD COLUMN idle_muted INTEGER NOT NULL DEFAULT 0',
    );
  }
  if (!agentCols.some((c) => c.name === 'input_block_mode')) {
    _db.exec(
      "ALTER TABLE agents ADD COLUMN input_block_mode TEXT NOT NULL DEFAULT 'off'",
    );
  }
  if (!agentCols.some((c) => c.name === 'auto_self_on_idle')) {
    _db.exec(
      'ALTER TABLE agents ADD COLUMN auto_self_on_idle INTEGER NOT NULL DEFAULT 1',
    );
  }

  const roomCols = _db.query('PRAGMA table_info(rooms)').all() as Array<{
    name: string;
  }>;
  if (!roomCols.some((c) => c.name === 'reminder_policy')) {
    _db.exec('ALTER TABLE rooms ADD COLUMN reminder_policy TEXT');
  }
  if (!roomCols.some((c) => c.name === 'reminder_dispatch_count')) {
    _db.exec(
      'ALTER TABLE rooms ADD COLUMN reminder_dispatch_count INTEGER NOT NULL DEFAULT 0',
    );
  }

  const sweepCols = _db
    .query('PRAGMA table_info(sweep_control)')
    .all() as Array<{
    name: string;
  }>;
  if (!sweepCols.some((c) => c.name === 'delivery_paused')) {
    _db.exec(
      'ALTER TABLE sweep_control ADD COLUMN delivery_paused INTEGER NOT NULL DEFAULT 0',
    );
  }
  if (!sweepCols.some((c) => c.name === 'pause_reason')) {
    _db.exec('ALTER TABLE sweep_control ADD COLUMN pause_reason TEXT');
  }
  if (!sweepCols.some((c) => c.name === 'busy_mode')) {
    _db.exec(
      "ALTER TABLE sweep_control ADD COLUMN busy_mode TEXT NOT NULL DEFAULT 'auto'",
    );
  }
  if (!sweepCols.some((c) => c.name === 'updated_at')) {
    _db.exec(
      "ALTER TABLE sweep_control ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
    );
  }
  _db.run(
    `INSERT OR IGNORE INTO sweep_control (id, delivery_paused, pause_reason, busy_mode, updated_at)
     VALUES (1, 0, NULL, 'auto', datetime('now'))`,
  );

  // Party mode columns on rooms table
  const roomCols2 = _db.query('PRAGMA table_info(rooms)').all() as Array<{
    name: string;
  }>;
  if (!roomCols2.some((c) => c.name === 'party_active')) {
    _db.exec('ALTER TABLE rooms ADD COLUMN party_active INTEGER DEFAULT 0');
  }
  if (!roomCols2.some((c) => c.name === 'party_round')) {
    _db.exec('ALTER TABLE rooms ADD COLUMN party_round INTEGER DEFAULT 0');
  }
  if (!roomCols2.some((c) => c.name === 'party_topic')) {
    _db.exec('ALTER TABLE rooms ADD COLUMN party_topic TEXT');
  }
  if (!roomCols2.some((c) => c.name === 'party_started_at')) {
    _db.exec('ALTER TABLE rooms ADD COLUMN party_started_at TEXT');
  }

  // Party responses table
  _db.exec(`
    CREATE TABLE IF NOT EXISTS party_responses (
      id INTEGER PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      agent_name TEXT NOT NULL,
      response TEXT NOT NULL,
      hook_event_id INTEGER REFERENCES hook_events(id),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(room_id, round, agent_name)
    )
  `);
  _db.exec(
    'CREATE INDEX IF NOT EXISTS idx_party_responses_room_round ON party_responses(room_id, round)',
  );

  // Registered-agent hint table (session-scoped, pane-bootstrap capable)
  _db.exec(`
    CREATE TABLE IF NOT EXISTS agent_hints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      pane_bootstrap TEXT,
      session_id TEXT,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      turn_count INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      cadence INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (pane_bootstrap IS NOT NULL OR session_id IS NOT NULL)
    )
  `);
  // Unique per-room: same pane/session can exist across rooms for multi-room agents.
  // Migration: drop old single-column unique indexes if they exist.
  _db.exec('DROP INDEX IF EXISTS idx_agent_hints_pane');
  _db.exec('DROP INDEX IF EXISTS idx_agent_hints_session');
  _db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_hints_pane ON agent_hints(pane_bootstrap, room_id) WHERE pane_bootstrap IS NOT NULL',
  );
  _db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_hints_session ON agent_hints(session_id, room_id) WHERE session_id IS NOT NULL',
  );
  _db.exec(
    'CREATE INDEX IF NOT EXISTS idx_agent_hints_agent_room ON agent_hints(agent_name, room_id)',
  );

  // Additive column migrations for agent_hints (custom message + cadence)
  const hintCols = _db.query('PRAGMA table_info(agent_hints)').all() as Array<{
    name: string;
  }>;
  if (!hintCols.some((c) => c.name === 'message')) {
    _db.exec(
      "ALTER TABLE agent_hints ADD COLUMN message TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!hintCols.some((c) => c.name === 'cadence')) {
    _db.exec(
      'ALTER TABLE agent_hints ADD COLUMN cadence INTEGER NOT NULL DEFAULT 3',
    );
  }

  // Goal tracking table
  _db.exec(`
    CREATE TABLE IF NOT EXISTS agent_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'done', 'abandoned')),
      pane_bootstrap TEXT,
      session_id TEXT,
      set_by TEXT NOT NULL DEFAULT 'self',
      turn_count INTEGER NOT NULL DEFAULT 0,
      leader_reminder_armed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      CHECK (pane_bootstrap IS NOT NULL OR session_id IS NOT NULL)
    )
  `);
  _db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_pane ON agent_goals(pane_bootstrap, room_id) WHERE pane_bootstrap IS NOT NULL',
  );
  _db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_session ON agent_goals(session_id, room_id) WHERE session_id IS NOT NULL',
  );
  _db.exec(
    'CREATE INDEX IF NOT EXISTS idx_goals_agent_room ON agent_goals(agent_name, room_id)',
  );

  // Leader ↔ worker dialog bridge: records a decision UI (AskUserQuestion or
  // ExitPlanMode) raised on a worker pane so the room's leader can answer it.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS leader_dialogs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      worker_name TEXT NOT NULL,
      worker_pane TEXT,
      leader_name TEXT,
      dialog_type TEXT NOT NULL DEFAULT 'ask_question'
        CHECK (dialog_type IN ('ask_question', 'plan_approval')),
      tool_name TEXT NOT NULL,
      session_id TEXT,
      questions TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'answered', 'expired')),
      answer TEXT,
      current_question_index INTEGER NOT NULL DEFAULT 0,
      question_answers TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      answered_at TEXT,
      source_hook_event_id INTEGER REFERENCES hook_events(id)
    )
  `);
  _db.exec(
    'CREATE INDEX IF NOT EXISTS idx_leader_dialogs_room_status ON leader_dialogs(room_id, status)',
  );
  _db.exec(
    'CREATE INDEX IF NOT EXISTS idx_leader_dialogs_worker ON leader_dialogs(worker_name, room_id, status)',
  );

  const dialogCols = _db
    .query('PRAGMA table_info(leader_dialogs)')
    .all() as Array<{ name: string }>;
  if (!dialogCols.some((c) => c.name === 'current_question_index')) {
    _db.exec(
      'ALTER TABLE leader_dialogs ADD COLUMN current_question_index INTEGER NOT NULL DEFAULT 0',
    );
  }
  if (!dialogCols.some((c) => c.name === 'question_answers')) {
    _db.exec('ALTER TABLE leader_dialogs ADD COLUMN question_answers TEXT');
  }

  const goalCols = _db.query('PRAGMA table_info(agent_goals)').all() as Array<{
    name: string;
  }>;
  if (!goalCols.some((c) => c.name === 'pending_completion_message')) {
    _db.exec(
      'ALTER TABLE agent_goals ADD COLUMN pending_completion_message TEXT',
    );
  }
  if (!goalCols.some((c) => c.name === 'pending_completion_batch_id')) {
    _db.exec(
      'ALTER TABLE agent_goals ADD COLUMN pending_completion_batch_id TEXT',
    );
  }
  if (!goalCols.some((c) => c.name === 'pending_completion_created_at')) {
    _db.exec(
      'ALTER TABLE agent_goals ADD COLUMN pending_completion_created_at TEXT',
    );
  }
  if (!goalCols.some((c) => c.name === 'leader_reminder_armed')) {
    _db.exec(
      'ALTER TABLE agent_goals ADD COLUMN leader_reminder_armed INTEGER NOT NULL DEFAULT 0',
    );
  }
  // Goal stuck-detector: when true, the goal reminder loop is paused after a
  // tight near-identical output loop was detected. Goal stays `active`; the
  // agent itself must run crew goal done/update/unset to resolve.
  if (!goalCols.some((c) => c.name === 'reminder_paused')) {
    _db.exec(
      'ALTER TABLE agent_goals ADD COLUMN reminder_paused INTEGER NOT NULL DEFAULT 0',
    );
  }

  // Rolling window of recent completion-output hashes per active goal, used by
  // the stuck detector. CASCADE-deleted with the goal row (unset/new set).
  _db.exec(`
    CREATE TABLE IF NOT EXISTS agent_goal_recent_outputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id INTEGER NOT NULL REFERENCES agent_goals(id) ON DELETE CASCADE,
      message_hash TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  _db.exec(
    'CREATE INDEX IF NOT EXISTS idx_goal_outputs_goal ON agent_goal_recent_outputs(goal_id, id)',
  );

  const scopes = [
    'agents',
    'messages',
    'templates',
    'room-templates',
    'hook-events',
    'party',
    'hints',
    'goals',
  ];
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
  _dbPath = null;
}

/**
 * Retry a DB operation with exponential backoff when encountering SQLITE_BUSY.
 * This handles the case where multiple `crew hook-event` processes contend
 * on the same SQLite file — WAL mode allows concurrent reads but serializes
 * writes, and busy_timeout may be exceeded under heavy contention.
 */
export function withRetry<T>(
  fn: () => T,
  maxRetries = 3,
  baseDelayMs = 200,
): T {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (e: unknown) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      // Only retry on SQLITE_BUSY or "database is locked" errors
      if (
        !msg.includes('BUSY') &&
        !msg.includes('locked') &&
        !msg.includes('busy')
      ) {
        throw e;
      }
      if (attempt < maxRetries) {
        const delay =
          baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 100);
        // Synchronous sleep for Bun — use Atomics.wait in a worker-like pattern
        const end = Date.now() + delay;
        while (Date.now() < end) {
          // busy-wait for short delays (200-1000ms)
        }
      }
    }
  }
  throw lastError;
}

/**
 * Initialise DB with retry — the most contention-prone operation since
 * every hook-event process calls this on startup.  Schema migrations hold
 * write locks, so concurrent initDb() calls from multiple processes are
 * the primary source of SQLITE_BUSY errors.
 */
export function initDbWithRetry(cwd?: string, maxRetries = 4): void {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      initDb(getDbPath(cwd));
      return;
    } catch (e: unknown) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (
        !msg.includes('BUSY') &&
        !msg.includes('locked') &&
        !msg.includes('busy')
      ) {
        throw e;
      }
      if (attempt < maxRetries) {
        const delay = 300 * 2 ** attempt + Math.floor(Math.random() * 200);
        const end = Date.now() + delay;
        while (Date.now() < end) {
          // busy-wait
        }
      }
    }
  }
  throw lastError;
}
