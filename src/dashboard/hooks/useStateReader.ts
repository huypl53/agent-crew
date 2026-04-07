import { useState, useEffect, useRef } from 'react';
import { Database } from 'bun:sqlite';
import type { Agent, Room, Message } from '../../shared/types.ts';
import { logError } from '../logger.ts';
import { existsSync } from 'fs';

const STATE_DIR = process.env.CREW_STATE_DIR ?? '/tmp/crew/state';
const DB_PATH = `${STATE_DIR}/crew.db`;
const POLL_INTERVAL = 500;

export interface DashboardState {
  agents: Record<string, Agent>;
  rooms: Record<string, Room>;
  messages: Message[];
}

const EMPTY_STATE: DashboardState = { agents: {}, rooms: {}, messages: [] };

function readAll(): DashboardState | null {
  let db: Database | null = null;
  try {
    if (!existsSync(DB_PATH)) return null;
    db = new Database(DB_PATH, { readonly: true });

    const agentRows = db.query<{ name: string; role: Agent['role']; pane: string; registered_at: string; last_activity: string | null }, []>(
      'SELECT name, role, pane, registered_at, last_activity FROM agents'
    ).all();
    const roomRows = db.query<{ name: string; topic: string | null; created_at: string }, []>(
      'SELECT name, topic, created_at FROM rooms'
    ).all();
    const memberRows = db.query<{ room: string; agent: string; joined_at: string }, []>(
      'SELECT room, agent, joined_at FROM members'
    ).all();
    const messageRows = db.query<{ id: number; sender: string; room: string; recipient: string | null; text: string; kind: Message['kind']; mode: Message['mode']; timestamp: string }, []>(
      'SELECT id, sender, room, recipient, text, kind, mode, timestamp FROM messages ORDER BY id ASC'
    ).all();

    const rooms: Record<string, Room> = {};
    for (const row of roomRows) {
      rooms[row.name] = { name: row.name, topic: row.topic ?? undefined, members: [], created_at: row.created_at };
    }
    const agentRooms = new Map<string, string[]>();
    for (const row of memberRows) {
      if (!rooms[row.room]) rooms[row.room] = { name: row.room, members: [], created_at: row.joined_at };
      rooms[row.room]!.members.push(row.agent);
      const existing = agentRooms.get(row.agent) ?? [];
      existing.push(row.room);
      agentRooms.set(row.agent, existing);
    }
    const agents: Record<string, Agent> = {};
    for (const row of agentRows) {
      agents[row.name] = {
        agent_id: row.name, name: row.name, role: row.role,
        rooms: agentRooms.get(row.name) ?? [],
        tmux_target: row.pane, joined_at: row.registered_at,
        last_activity: row.last_activity ?? undefined,
      };
    }
    const messages: Message[] = messageRows.map(row => ({
      message_id: String(row.id), from: row.sender, room: row.room,
      to: row.recipient, text: row.text, kind: row.kind,
      timestamp: row.timestamp, sequence: row.id, mode: row.mode,
    }));
    return { agents, rooms, messages };
  } catch (e) {
    logError('state-reader.readAll', e);
    return null;
  } finally {
    db?.close(false);
  }
}

export function useStateReader() {
  const [state, setState] = useState<DashboardState>(EMPTY_STATE);
  const [isAvailable, setIsAvailable] = useState(false);
  const lastDataVersion = useRef(0);
  const lastHash = useRef('');

  useEffect(() => {
    const initial = readAll();
    if (initial) {
      const hash = quickHash(initial);
      lastHash.current = hash;
      setState(initial);
      setIsAvailable(true);
    }

    const timer = setInterval(() => {
      let db: Database | null = null;
      try {
        if (!existsSync(DB_PATH)) {
          if (isAvailable) { setState(EMPTY_STATE); setIsAvailable(false); lastDataVersion.current = 0; lastHash.current = ''; }
          return;
        }
        db = new Database(DB_PATH, { readonly: true });
        const row = db.query<{ data_version: number }, []>('PRAGMA data_version').get();
        const version = row?.data_version ?? 0;
        if (version !== lastDataVersion.current || !isAvailable) {
          lastDataVersion.current = version;
          db.close(false);
          db = null;
          const next = readAll();
          if (next) {
            const hash = quickHash(next);
            if (hash !== lastHash.current) {
              lastHash.current = hash;
              setState(next);
            }
            setIsAvailable(true);
          }
          else { setState(EMPTY_STATE); setIsAvailable(false); lastHash.current = ''; }
        }
      } catch (e) {
        logError('state-reader.poll', e);
        setState(EMPTY_STATE); setIsAvailable(false); lastDataVersion.current = 0; lastHash.current = '';
      } finally {
        db?.close(false);
      }
    }, POLL_INTERVAL);

    return () => clearInterval(timer);
  }, []);

  return { state, isAvailable };
}

/** Fast structural hash to avoid unnecessary re-renders when data hasn't changed */
function quickHash(state: DashboardState): string {
  const agentKeys = Object.keys(state.agents).sort().join(',');
  const roomKeys = Object.keys(state.rooms).sort().join(',');
  const msgCount = state.messages.length;
  const lastMsgId = state.messages[state.messages.length - 1]?.message_id ?? '';
  return `${agentKeys}|${roomKeys}|${msgCount}|${lastMsgId}`;
}
