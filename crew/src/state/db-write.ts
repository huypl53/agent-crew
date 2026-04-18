/**
 * Write operations for the dashboard UI.
 * Opens short-lived write connections with WAL + busy_timeout to handle concurrency
 * with the MCP server process.
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import { getDbPath } from './db.ts';

function withDb<T>(fn: (db: Database) => T): { result?: T; error?: string } {
  const path = getDbPath();
  if (!existsSync(path)) return { error: 'Database not available' };
  const db = new Database(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  try {
    return { result: fn(db) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    db.close(false);
  }
}

export function dbSetTopic(room: string, topic: string): { error?: string } {
  const { error } = withDb(db => {
    db.run('UPDATE rooms SET topic = ? WHERE name = ?', [topic, room]);
  });
  return error ? { error } : {};
}

export function dbCreateRoom(name: string, topic?: string, templateIds?: number[], path?: string): { error?: string } {
  const { error } = withDb(db => {
    const roomPath = path ?? `/virtual/${name}`;
    const exists = db.query('SELECT 1 FROM rooms WHERE path = ?').get(roomPath);
    if (exists) throw new Error('Room already exists');
    const result = db.run(
      'INSERT INTO rooms (path, name, topic, created_at) VALUES (?, ?, ?, ?)',
      [roomPath, name, topic ?? null, new Date().toISOString()],
    );
    const roomId = Number(result.lastInsertRowid);
    if (templateIds && templateIds.length > 0) {
      for (const id of templateIds) {
        db.run('INSERT OR IGNORE INTO room_templates (room_id, template_id) VALUES (?, ?)', [roomId, id]);
      }
    }
  });
  return error ? { error } : {};
}

export function dbCreateTemplate(name: string, role: string, persona?: string, capabilities?: string): { error?: string } {
  const { error } = withDb(db => {
    db.run(
      'INSERT INTO agent_templates (name, role, persona, capabilities, created_at) VALUES (?, ?, ?, ?, ?)',
      [name, role, persona ?? null, capabilities ?? null, new Date().toISOString()],
    );
  });
  return error ? { error } : {};
}

export function dbUpdateTemplate(id: number, field: 'name' | 'role' | 'persona' | 'capabilities', value: string): { error?: string } {
  const allowed = ['name', 'role', 'persona', 'capabilities'];
  if (!allowed.includes(field)) return { error: 'Invalid field' };
  const { error } = withDb(db => {
    db.run(`UPDATE agent_templates SET ${field} = ? WHERE id = ?`, [value, id]);
  });
  return error ? { error } : {};
}

export function dbDeleteTemplate(id: number): { error?: string } {
  const { error } = withDb(db => {
    db.run('DELETE FROM agent_templates WHERE id = ?', [id]);
  });
  return error ? { error } : {};
}

export function dbDeleteRoom(name: string): { error?: string } {
  const { error } = withDb(db => {
    // CASCADE on rooms handles agents, messages, tasks, cursors
    db.run('DELETE FROM rooms WHERE name = ?', [name]);
  });
  return error ? { error } : {};
}

export function dbUpdateAgentPersona(name: string, persona: string): { error?: string } {
  const { error } = withDb(db => {
    db.run('UPDATE agents SET persona = ? WHERE name = ?', [persona, name]);
  });
  return error ? { error } : {};
}

export function dbUpdateAgentCapabilities(name: string, capabilities: string[]): { error?: string } {
  const { error } = withDb(db => {
    db.run('UPDATE agents SET capabilities = ? WHERE name = ?', [JSON.stringify(capabilities), name]);
  });
  return error ? { error } : {};
}

export function dbRemoveAgentFromRoom(agentName: string, room: string): { error?: string } {
  const { error } = withDb(db => {
    const roomRow = db.query('SELECT id FROM rooms WHERE name = ? ORDER BY id LIMIT 1').get(room) as { id: number } | null;
    if (!roomRow) return;
    db.run('DELETE FROM agents WHERE name = ? AND room_id = ?', [agentName, roomRow.id]);
  });
  return error ? { error } : {};
}

export function dbDeleteAgent(name: string): { removed_from_rooms: string[]; error?: string } {
  let removed_from_rooms: string[] = [];
  const { error } = withDb(db => {
    const agentRow = db.query(`
      SELECT a.id, r.name as room_name
      FROM agents a JOIN rooms r ON r.id = a.room_id
      WHERE a.name = ?
    `).get(name) as { id: number; room_name: string } | null;
    if (agentRow) {
      removed_from_rooms = [agentRow.room_name];
      db.run('DELETE FROM agents WHERE id = ?', [agentRow.id]);
    }
  });
  return error ? { removed_from_rooms: [], error } : { removed_from_rooms };
}

// --- Room Template CRUD ---

export function dbCreateRoomTemplate(name: string, topic: string | null, agentTemplateIds: number[]): { error?: string } {
  const { error } = withDb(db => {
    db.run(
      'INSERT INTO room_template_definitions (name, topic, agent_template_ids, created_at) VALUES (?, ?, ?, ?)',
      [name, topic, JSON.stringify(agentTemplateIds), new Date().toISOString()],
    );
  });
  return error ? { error } : {};
}

export function dbUpdateRoomTemplate(id: number, field: 'name' | 'topic' | 'agent_template_ids', value: string): { error?: string } {
  const allowed = ['name', 'topic', 'agent_template_ids'];
  if (!allowed.includes(field)) return { error: 'Invalid field' };
  const { error } = withDb(db => {
    db.run(`UPDATE room_template_definitions SET ${field} = ? WHERE id = ?`, [value, id]);
  });
  return error ? { error } : {};
}

export function dbDeleteRoomTemplate(id: number): { error?: string } {
  const { error } = withDb(db => {
    db.run('DELETE FROM room_template_definitions WHERE id = ?', [id]);
  });
  return error ? { error } : {};
}

export function dbSetRoomTemplates(room: string, templateIds: number[]): { error?: string } {
  const { error } = withDb(db => {
    const roomRow = db.query('SELECT id FROM rooms WHERE name = ? ORDER BY id LIMIT 1').get(room) as { id: number } | null;
    if (!roomRow) throw new Error('Room not found');
    db.run('DELETE FROM room_templates WHERE room_id = ?', [roomRow.id]);
    for (const id of templateIds) {
      db.run('INSERT OR IGNORE INTO room_templates (room_id, template_id) VALUES (?, ?)', [roomRow.id, id]);
    }
  });
  return error ? { error } : {};
}

/** Clear agent's pane when dead pane detected during delivery */
export function dbClearAgentPane(name: string, pane: string): { error?: string } {
  const { error } = withDb(db => {
    db.run("UPDATE agents SET pane = NULL, status = 'unknown' WHERE name = ? AND pane = ?", [name, pane]);
  });
  return error ? { error } : {};
}
