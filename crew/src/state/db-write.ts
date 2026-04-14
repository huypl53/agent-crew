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

export function dbCreateRoom(name: string, topic?: string): { error?: string } {
  const { error } = withDb(db => {
    const exists = db.query('SELECT 1 FROM rooms WHERE name = ?').get(name);
    if (exists) throw new Error('Room already exists');
    db.run(
      'INSERT INTO rooms (name, topic, created_at) VALUES (?, ?, ?)',
      [name, topic ?? null, new Date().toISOString()],
    );
  });
  return error ? { error } : {};
}

export function dbDeleteRoom(name: string): { error?: string } {
  const { error } = withDb(db => {
    db.run('DELETE FROM messages WHERE room = ?', [name]);
    db.run('DELETE FROM cursors WHERE room = ?', [name]);
    db.run('DELETE FROM members WHERE room = ?', [name]);
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
    db.run('DELETE FROM members WHERE agent = ? AND room = ?', [agentName, room]);
    const agentRooms = (db.query('SELECT COUNT(*) as c FROM members WHERE agent = ?').get(agentName) as { c: number }).c;
    if (agentRooms === 0) {
      db.run('DELETE FROM agents WHERE name = ?', [agentName]);
      db.run('DELETE FROM cursors WHERE agent = ?', [agentName]);
    }
    const roomMembers = (db.query('SELECT COUNT(*) as c FROM members WHERE room = ?').get(room) as { c: number }).c;
    if (roomMembers === 0) {
      db.run('DELETE FROM rooms WHERE name = ?', [room]);
    }
  });
  return error ? { error } : {};
}

export function dbDeleteAgent(name: string): { removed_from_rooms: string[]; error?: string } {
  let removed_from_rooms: string[] = [];
  const { error } = withDb(db => {
    removed_from_rooms = (db.query('SELECT room FROM members WHERE agent = ?').all(name) as { room: string }[]).map(r => r.room);
    db.run('DELETE FROM members WHERE agent = ?', [name]);
    db.run('DELETE FROM cursors WHERE agent = ?', [name]);
    db.run('DELETE FROM agents WHERE name = ?', [name]);
    for (const room of removed_from_rooms) {
      const count = (db.query('SELECT COUNT(*) as c FROM members WHERE room = ?').get(room) as { c: number }).c;
      if (count === 0) db.run('DELETE FROM rooms WHERE name = ?', [room]);
    }
  });
  return error ? { removed_from_rooms: [], error } : { removed_from_rooms };
}
