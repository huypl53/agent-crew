import { Database } from 'bun:sqlite';
import type { Agent, Room, Message } from '../shared/types.ts';

const STATE_DIR = process.env.CC_TMUX_STATE_DIR ?? '/tmp/cc-tmux/state';
const DB_PATH = `${STATE_DIR}/cc-tmux.db`;
const POLL_INTERVAL = 500;

export interface DashboardState {
  agents: Record<string, Agent>;
  rooms: Record<string, Room>;
  messages: Message[];
}

export type StateChangeHandler = (state: DashboardState) => void;

type AgentRow = {
  name: string;
  role: Agent['role'];
  pane: string;
  registered_at: string;
  last_activity: string | null;
};

type RoomRow = {
  name: string;
  topic: string | null;
  created_at: string;
};

type MemberRow = {
  room: string;
  agent: string;
  joined_at: string;
};

type MessageRow = {
  id: number;
  sender: string;
  room: string;
  recipient: string | null;
  text: string;
  kind: Message['kind'];
  mode: Message['mode'];
  timestamp: string;
};

export class StateReader {
  private state: DashboardState = { agents: {}, rooms: {}, messages: [] };
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onChange: StateChangeHandler | null = null;
  private stateExists = false;
  private lastMessageId = 0;

  get current(): DashboardState { return this.state; }
  get isAvailable(): boolean { return this.stateExists; }

  async init(): Promise<DashboardState> {
    await this.readAll();
    this.startPolling();
    return this.state;
  }

  setChangeHandler(handler: StateChangeHandler): void {
    this.onChange = handler;
  }

  private async readAll(): Promise<void> {
    if (!await this.dbExists()) {
      this.stateExists = false;
      this.lastMessageId = 0;
      this.state = { agents: {}, rooms: {}, messages: [] };
      return;
    }

    let db: Database | null = null;
    try {
      db = new Database(DB_PATH, { readonly: true });

      const agentRows = db.query<AgentRow, []>(
        'SELECT name, role, pane, registered_at, last_activity FROM agents'
      ).all();
      const roomRows = db.query<RoomRow, []>(
        'SELECT name, topic, created_at FROM rooms'
      ).all();
      const memberRows = db.query<MemberRow, []>(
        'SELECT room, agent, joined_at FROM members'
      ).all();
      const messageRows = db.query<MessageRow, []>(
        'SELECT id, sender, room, recipient, text, kind, mode, timestamp FROM messages ORDER BY id ASC'
      ).all();

      const rooms: Record<string, Room> = {};
      for (const row of roomRows) {
        rooms[row.name] = {
          name: row.name,
          topic: row.topic ?? undefined,
          members: [],
          created_at: row.created_at,
        };
      }

      const agentRooms = new Map<string, string[]>();
      for (const row of memberRows) {
        if (!rooms[row.room]) {
          rooms[row.room] = { name: row.room, members: [], created_at: row.joined_at };
        }
        rooms[row.room]!.members.push(row.agent);
        const existing = agentRooms.get(row.agent) ?? [];
        existing.push(row.room);
        agentRooms.set(row.agent, existing);
      }

      const agents: Record<string, Agent> = {};
      for (const row of agentRows) {
        agents[row.name] = {
          agent_id: row.name,
          name: row.name,
          role: row.role,
          rooms: agentRooms.get(row.name) ?? [],
          tmux_target: row.pane,
          joined_at: row.registered_at,
          last_activity: row.last_activity ?? undefined,
        };
      }

      const messages: Message[] = messageRows.map(row => ({
        message_id: String(row.id),
        from: row.sender,
        room: row.room,
        to: row.recipient,
        text: row.text,
        kind: row.kind,
        timestamp: row.timestamp,
        sequence: row.id,
        mode: row.mode,
      }));

      this.state = { agents, rooms, messages };
      this.stateExists = true;
      this.lastMessageId = messageRows.at(-1)?.id ?? 0;
    } catch {
      this.stateExists = false;
      this.lastMessageId = 0;
      this.state = { agents: {}, rooms: {}, messages: [] };
    } finally {
      db?.close(false);
    }
  }

  private async dbExists(): Promise<boolean> {
    try {
      return await Bun.file(DB_PATH).exists();
    } catch {
      return false;
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      if (!await this.dbExists()) {
        if (this.stateExists) {
          this.stateExists = false;
          this.lastMessageId = 0;
          this.state = { agents: {}, rooms: {}, messages: [] };
          this.onChange?.(this.state);
        }
        return;
      }

      let db: Database | null = null;
      try {
        db = new Database(DB_PATH, { readonly: true });
        const row = db.query<{ max_id: number | null }, []>('SELECT MAX(id) AS max_id FROM messages').get();
        const nextMax = row?.max_id ?? 0;

        if (!this.stateExists) {
          await this.readAll();
          this.onChange?.(this.state);
          return;
        }

        if (nextMax !== this.lastMessageId) {
          await this.readAll();
          this.onChange?.(this.state);
        }
      } catch {
        if (this.stateExists) {
          this.stateExists = false;
          this.lastMessageId = 0;
          this.state = { agents: {}, rooms: {}, messages: [] };
          this.onChange?.(this.state);
        }
      } finally {
        db?.close(false);
      }
    }, POLL_INTERVAL);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}
