export type AgentRole = 'boss' | 'leader' | 'worker';
export type AgentStatus = 'idle' | 'busy' | 'dead' | 'unknown';

export interface Agent {
  agent_id: string;
  name: string;
  role: AgentRole;
  rooms: string[];
  tmux_target: string | null;
  agent_type: 'claude-code' | 'codex' | 'unknown';
  joined_at: string;
  last_activity?: string;
  persona?: string;
  capabilities?: string;
}

export interface Room {
  name: string;
  members: string[];
  topic?: string;
  created_at: string;
}

export type MessageKind = 'task' | 'completion' | 'question' | 'error' | 'status' | 'chat' | 'note';

/** Internal status update event kinds used for push-based notifications. */
export type StatusUpdateKind =
  | 'worker_started'    // Worker began processing a task
  | 'worker_completed'  // Worker finished a task
  | 'worker_blocked'    // Worker needs help
  | 'worker_heartbeat'  // Worker is alive but busy
  | 'ack_received';     // Delivery confirmed

export interface Message {
  message_id: string;
  from: string;
  room: string;
  to: string | null;
  text: string;
  kind: MessageKind;
  timestamp: string;
  sequence: number;
  mode: 'push' | 'pull';
  reply_to?: number | null;
}

export type TaskStatus = 'sent' | 'queued' | 'active' | 'completed' | 'error' | 'interrupted' | 'cancelled';

export interface Task {
  id: number;
  room: string;
  assigned_to: string;
  created_by: string;
  message_id: number | null;
  text?: string;
  summary: string;
  status: TaskStatus;
  note?: string;
  context?: string;
  created_at: string;
  updated_at: string;
}

export interface TaskEvent {
  id: number;
  task_id: number;
  from_status: string | null;
  to_status: string;
  triggered_by: string | null;
  timestamp: string;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function ok(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export function err(error: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true };
}

/* ── Token tracking ─────────────────────────────────────── */

export interface TokenUsage {
  id: number;
  agent_name: string;
  session_id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  source: 'statusline' | 'jsonl' | 'codex_db';
  recorded_at: string;
}

export interface PricingEntry {
  model_name: string;
  input_cost_per_million: number;
  output_cost_per_million: number;
}
