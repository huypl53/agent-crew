export type AgentRole = 'leader' | 'worker';
export type AgentStatus = 'idle' | 'busy' | 'dead' | 'unknown';
export type InputBlockMode = 'off' | 'armed' | 'persist';

export type ReminderCadenceMode = 'always' | 'every_n';

export interface ReminderPolicy {
  enabled: boolean;
  prefix: string;
  suffix: string;
  cadence_mode: ReminderCadenceMode;
  cadence_n: number;
}

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
  input_block_mode: InputBlockMode;
  persona: string | null;
  capabilities: string | null;
  reminder_policy: ReminderPolicy | null;
}

export interface Room {
  id: number;
  path: string;
  name: string;
  topic: string | null;
  created_at: string;
  reminder_policy: ReminderPolicy | null;
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
  return `${randomSuffix()}`;
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

export interface HookEvent {
  id: number;
  agent_name: string;
  event_type: string;
  session_id: string | null;
  payload: string | null;
  created_at: string;
}

export type SweepBusyMode = 'auto' | 'manual_busy' | 'manual_free';

export interface SweepControlState {
  delivery_paused: boolean;
  pause_reason: string | null;
  busy_mode: SweepBusyMode;
  updated_at: string;
}

/* ── Party mode types ──────────────────────────────────── */

export interface PartyState {
  active: boolean;
  round: number;
  topic: string | null;
  started_at: string | null;
}

export interface PartyResponse {
  id: number;
  room_id: number;
  round: number;
  agent_name: string;
  response: string;
  hook_event_id: number | null;
  created_at: string;
}
