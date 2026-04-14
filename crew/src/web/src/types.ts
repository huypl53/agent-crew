export interface Room {
  name: string;
  members: string[];
  topic?: string;
  created_at: string;
}

export interface Agent {
  agent_id: string;
  name: string;
  role: 'boss' | 'leader' | 'worker';
  rooms: string[];
  tmux_target: string | null;
  agent_type: 'claude-code' | 'codex' | 'unknown';
  joined_at: string;
  last_activity?: string;
  persona?: string;
  capabilities?: string;
  status: 'busy' | 'idle' | 'dead' | 'unknown';
}

export interface Message {
  message_id: string;
  from: string;
  room: string;
  to: string | null;
  text: string;
  kind: string;
  timestamp: string;
  sequence: number;
  mode: 'push' | 'pull';
  reply_to?: number | null;
}

export interface WsEvent {
  type: 'message' | 'task-update' | 'agent-status' | 'room-change';
  [key: string]: unknown;
}
