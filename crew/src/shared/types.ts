export type AgentRole = 'boss' | 'leader' | 'worker';
export type AgentStatus = 'idle' | 'busy' | 'dead' | 'unknown';

export interface Agent {
  agent_id: number;
  room_id: number;
  room_path: string;
  room_name: string;
  name: string;
  role: AgentRole;
  tmux_target: string | null;
  agent_type: 'claude-code' | 'codex' | 'unknown';
  status: string | null;
  persona: string | null;
  capabilities: string | null;
}

export interface Room {
  id: number;
  path: string;
  name: string;
  topic: string | null;
  created_at: string;
}

export interface AgentTemplate {
  id: number;
  name: string;
  role: AgentRole;
  persona?: string;
  capabilities?: string;
  start_command?: string;
  created_at: string;
}

export interface RoomTemplate {
  id: number;
  name: string;
  topic: string | null;
  agent_template_ids: number[];
  created_at: string;
}

export type MessageKind =
  | 'task'
  | 'completion'
  | 'question'
  | 'error'
  | 'status'
  | 'chat'
  | 'note';

export interface Message {
  message_id: string;
  from: string;
  room_id: number;
  to: string | null;
  text: string;
  kind: MessageKind;
  timestamp: string;
  sequence: number;
  mode: 'push' | 'pull';
  reply_to?: number | null;
}

export type TaskStatus =
  | 'sent'
  | 'queued'
  | 'active'
  | 'completed'
  | 'error'
  | 'interrupted'
  | 'cancelled';

export interface Task {
  id: number;
  room_id: number;
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
  return {
    content: [{ type: 'text', text: JSON.stringify({ error }) }],
    isError: true,
  };
}

/* ── Random name generation ─────────────────────────────── */

const NAME_CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randomSuffix(length = 4): string {
  let s = '';
  for (let i = 0; i < length; i++)
    s += NAME_CHARSET[Math.floor(Math.random() * NAME_CHARSET.length)];
  return s;
}

export function generateRandomName(): string {
  return `agent-${randomSuffix()}`;
}

/* ── Token tracking ─────────────────────────────────────── */

export interface TokenUsage {
  id: number;
  agent_id: number;
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
