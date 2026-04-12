import { useState, useEffect, useRef } from 'react';
import { Database } from 'bun:sqlite';
import type { Agent, Room, Message, Task, TaskEvent, TokenUsage } from '../../shared/types.ts';
import { logError } from '../logger.ts';
import { existsSync } from 'fs';

const STATE_DIR = process.env.CREW_STATE_DIR ?? '/tmp/crew/state';
const DB_PATH = `${STATE_DIR}/crew.db`;
const POLL_INTERVAL = 500;

export interface DashboardState {
  agents: Record<string, Agent>;
  rooms: Record<string, Room>;
  messages: Message[];
  tasks: Task[];
  taskEvents: TaskEvent[];
  tokenUsage: TokenUsage[];
}

const EMPTY_STATE: DashboardState = { agents: {}, rooms: {}, messages: [], tasks: [], taskEvents: [], tokenUsage: [] };

function readAll(): DashboardState | null {
  let db: Database | null = null;
  try {
    if (!existsSync(DB_PATH)) return null;
    db = new Database(DB_PATH, { readonly: true });

    let agentRows: { name: string; role: Agent['role']; pane: string; agent_type?: string; registered_at: string; last_activity: string | null }[] = [];
    try {
      agentRows = db.query<typeof agentRows[0], []>(
        'SELECT name, role, pane, agent_type, registered_at, last_activity FROM agents'
      ).all();
    } catch {
      // agent_type column may not exist in older DBs — fall back to core columns
      try {
        agentRows = db.query<typeof agentRows[0], []>(
          'SELECT name, role, pane, registered_at, last_activity FROM agents'
        ).all();
      } catch {
        // agents table may not exist at all
      }
    }
    let roomRows: { name: string; topic: string | null; created_at: string }[] = [];
    try {
      roomRows = db.query<typeof roomRows[0], []>(
        'SELECT name, topic, created_at FROM rooms'
      ).all();
    } catch {
      // rooms table may not exist yet
    }
    let memberRows: { room: string; agent: string; joined_at: string }[] = [];
    try {
      memberRows = db.query<typeof memberRows[0], []>(
        'SELECT room, agent, joined_at FROM members'
      ).all();
    } catch {
      // members table may not exist yet
    }
    let messageRows: { id: number; sender: string; room: string; recipient: string | null; text: string; kind: Message['kind']; mode: Message['mode']; timestamp: string }[] = [];
    try {
      messageRows = db.query<typeof messageRows[0], []>(
        'SELECT id, sender, room, recipient, text, kind, mode, timestamp FROM messages ORDER BY id ASC'
      ).all();
    } catch {
      // messages table may not exist yet
    }

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
        tmux_target: row.pane, agent_type: (row.agent_type ?? 'unknown') as any, joined_at: row.registered_at,
        last_activity: row.last_activity ?? undefined,
      };
    }
    const messages: Message[] = messageRows.map(row => ({
      message_id: String(row.id), from: row.sender, room: row.room,
      to: row.recipient, text: row.text, kind: row.kind,
      timestamp: row.timestamp, sequence: row.id, mode: row.mode,
    }));

    let tasks: Task[] = [];
    try {
      const taskRows = db.query<{
        id: number; room: string; assigned_to: string; created_by: string;
        message_id: number | null; summary: string; status: string; note: string | null; context: string | null;
        created_at: string; updated_at: string;
      }, []>('SELECT * FROM tasks ORDER BY id ASC').all();

      tasks = taskRows.map(row => ({
        id: row.id,
        room: row.room,
        assigned_to: row.assigned_to,
        created_by: row.created_by,
        message_id: row.message_id,
        summary: row.summary,
        status: row.status as Task['status'],
        note: row.note ?? undefined,
        context: row.context ?? undefined,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }));
    } catch {
      // tasks table may not exist in older DBs — treat as empty
    }

    let tokenUsage: TokenUsage[] = [];
    try {
      tokenUsage = db.prepare('SELECT * FROM token_usage ORDER BY recorded_at DESC').all() as TokenUsage[];
    } catch {
      // token_usage table may not exist in older DBs
    }

    let taskEvents: TaskEvent[] = [];
    try {
      taskEvents = db.prepare('SELECT * FROM task_events ORDER BY timestamp ASC').all() as TaskEvent[];
    } catch {
      // task_events table may not exist in older DBs
    }

    return { agents, rooms, messages, tasks, taskEvents, tokenUsage };
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
  const taskCount = state.tasks.length;
  const lastTaskStatus = state.tasks[state.tasks.length - 1]?.status ?? '';
  const taskEventCount = state.taskEvents.length;
  const tokenCount = state.tokenUsage.length;
  const latestTokenCost = state.tokenUsage[0]?.cost_usd ?? 0;
  return `${agentKeys}|${roomKeys}|${msgCount}|${lastMsgId}|${taskCount}|${lastTaskStatus}|${taskEventCount}|${tokenCount}|${latestTokenCost}`;
}
