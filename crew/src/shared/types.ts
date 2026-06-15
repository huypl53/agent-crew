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

export interface Message {
  message_id: string;
  from: string;
  room_id: number;
  to: string | null;
  text: string;
  timestamp: string;
  sequence: number;
  reply_to?: number | null;
  batch_id?: string | null;
  worker_name?: string | null;
  prompt_file?: string | null;
  manifest_order?: number | null;
}

export interface MessageDeliveryMetadata {
  batch_id?: string;
  worker_name?: string;
  prompt_file?: string;
  manifest_order?: number;
}

export interface SendBatchManifestWorker {
  name: string;
  file: string;
}

export interface SendBatchManifest {
  leader?: string;
  workers: SendBatchManifestWorker[];
  hintAfterSeconds?: number;
}

export type MessageBatchStatus = 'running' | 'completed';
export type MessageBatchWorkerDispatchStatus = 'pending' | 'sent' | 'failed';
export type MessageBatchWorkerTerminalStatus =
  | 'running'
  | 'success'
  | 'error'
  | 'interrupted';
export type MessageBatchWorkerTerminalOutcome = Exclude<
  MessageBatchWorkerTerminalStatus,
  'running'
>;

export interface MessageBatch {
  id: number;
  batch_id: string;
  room_id: number;
  leader_name: string;
  status: MessageBatchStatus;
  hint_after_seconds: number | null;
  hint_sent_at: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface MessageBatchWorker {
  id: number;
  batch_id: string;
  worker_name: string;
  manifest_order: number;
  prompt_file: string;
  dispatch_status: MessageBatchWorkerDispatchStatus;
  terminal_status: MessageBatchWorkerTerminalStatus;
  final_message: string | null;
  error_text: string | null;
  started_at: string | null;
  finished_at: string | null;
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

const ADJECTIVES = [
  'swift',
  'calm',
  'bold',
  'keen',
  'warm',
  'cool',
  'bright',
  'steady',
  'quiet',
  'deep',
  'sharp',
  'quick',
  'still',
  'wild',
  'fair',
  'firm',
  'vivid',
  'crisp',
  'clear',
  'solid',
  'noble',
  'gentle',
  'fierce',
  'stout',
  'agile',
  'rustic',
  'sleek',
  'sturdy',
  'brave',
  'brisk',
  'dapper',
  'eager',
  'hardy',
  'jovial',
  'lithe',
  'plucky',
  'robust',
  'savvy',
  'trusty',
  'zen',
  'van',
  'thi',
  'minh',
  'duc',
  'thanh',
  'hai',
  'ngoc',
  'xuan',
  'duy',
  'tien',
  'anh',
  'cong',
  'bao',
  'gia',
  'quoc',
  'trong',
  'dinh',
  'khac',
  'nguyen',
  'hoang',
  'huu',
  'dang',
  'phuoc',
  'quang',
  'nhu',
  'thuy',
  'hong',
  'kim',
  'cam',
  'diem',
  'my',
  'khanh',
  'tu',
  'chong',
  'vinh',
] as const;

const NOUNS = [
  'falcon',
  'otter',
  'panda',
  'tiger',
  'crane',
  'raven',
  'lynx',
  'badger',
  'heron',
  'robin',
  'coyote',
  'marten',
  'finch',
  'lark',
  'egret',
  'mongoose',
  'vole',
  'puffin',
  'ibis',
  'bandicoot',
  'dugong',
  'pillbug',
  'fennec',
  'krill',
  'albatross',
  'mantis',
  'narwhal',
  'quail',
  'shrike',
  'wolverine',
  'caracal',
  'obsidian',
  'garnet',
  'basalt',
  'cinder',
  'ember',
  'dusk',
  'vale',
  'pine',
  'bloom',
  'anh',
  'dung',
  'nam',
  'lan',
  'linh',
  'mai',
  'phong',
  'quan',
  'son',
  'vy',
  'huy',
  'hung',
  'tuong',
  'dat',
  'khoi',
  'long',
  'khanh',
  'cuong',
  'binh',
  'tam',
  'phuc',
  'loc',
  'tho',
  'tai',
  'trung',
  'huong',
  'dung',
  'hoa',
  'ha',
  'giang',
  'yen',
  'oanh',
  'phuong',
  'thao',
  'quyen',
  'nghi',
  'thu',
  'dong',
  'viet',
  'trang',
] as const;
/** Short random suffix for collision resolution (alphanumeric, lowercase). */
export function randomSuffix(length = 4): string {
  const charset = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < length; i++)
    s += charset[Math.floor(Math.random() * charset.length)];
  return s;
}

/** Generate a memorable adjective-noun name like swift-falcon, bold-tiger. */
export function generateRandomName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
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
