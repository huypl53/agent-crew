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

export type TaskStatus = 'sent' | 'queued' | 'active' | 'completed' | 'error' | 'cancelled' | 'interrupted';

export interface Task {
  id: number;
  room: string;
  assigned_to: string;
  created_by: string;
  summary: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  text?: string;
  note?: string;
}

export interface TaskEvent {
  id: number;
  task_id: number;
  from_status: string | null;
  to_status: string;
  triggered_by: string | null;
  timestamp: string;
}

export interface WsEvent {
  type: 'message' | 'task-update' | 'agent-status' | 'room-change';
  [key: string]: unknown;
}

// TODO: merge with track A types
export type TraceNodeKind = 'root' | 'room' | 'agent' | 'task' | 'message';
export type TraceNodeStatus =
  | 'queued' | 'active' | 'done' | 'error'
  | 'idle' | 'busy' | 'dead' | 'note'
  | null;

export interface TraceNode {
  id: string;
  kind: TraceNodeKind;
  label: string;
  status: TraceNodeStatus;
  timestamp: number | null;
  durationMs: number | null;
  children: TraceNode[];
  meta: Record<string, unknown>;
}
