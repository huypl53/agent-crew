export type AgentRole = 'boss' | 'leader' | 'worker';
export type AgentStatus = 'idle' | 'busy' | 'dead' | 'unknown';

export interface Agent {
  agent_id: string;
  name: string;
  role: AgentRole;
  rooms: string[];
  tmux_target: string;
  agent_type: 'claude-code' | 'codex' | 'unknown';
  joined_at: string;
  last_activity?: string;
}

export interface Room {
  name: string;
  members: string[];
  topic?: string;
  created_at: string;
}

export type MessageKind = 'task' | 'completion' | 'question' | 'error' | 'status' | 'chat';

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
}

export type TaskStatus = 'sent' | 'queued' | 'active' | 'completed' | 'error' | 'interrupted' | 'cancelled';

export interface Task {
  id: number;
  room: string;
  assigned_to: string;
  created_by: string;
  message_id: number | null;
  summary: string;
  status: TaskStatus;
  note?: string;
  created_at: string;
  updated_at: string;
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
