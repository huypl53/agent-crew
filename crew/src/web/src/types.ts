export interface Room {
  name: string;
  members: string[];
  topic?: string;
  created_at: string;
}

export interface TokenUsage {
  agent_name: string;
  session_id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  recorded_at: string;
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
  token_usage?: TokenUsage | null;
  message_stats?: { sent: number; received: number };
  task_stats?: { done: number; active: number; queued: number; error: number };
}

export interface Stats {
  agents: { busy: number; idle: number; dead: number; total: number };
  tasks: { done: number; active: number; queued: number; error: number; total: number };
  cost: { total_usd: number | null; total_input_tokens: number; total_output_tokens: number };
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
