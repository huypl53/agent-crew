export interface Room {
  id: number;
  path: string;
  name: string;
  member_count: number;
  topic?: string;
  created_at: string;
  template_names?: string[];
}

export interface AgentTemplate {
  id: number;
  name: string;
  role: 'leader' | 'worker';
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

export interface TmuxWindowPane {
  pane_id: string;
  pane_index: number;
  title: string;
  active: boolean;
}

export interface TmuxWindowInfo {
  index: number;
  name: string;
  active: boolean;
  pane_count: number;
  panes: TmuxWindowPane[];
}

export interface TmuxWindowsResponse {
  session: string;
  active_window_index: number | null;
  windows: TmuxWindowInfo[];
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
  role: 'leader' | 'worker';
  room_id: number;
  room_name: string;
  room_path: string;
  tmux_target: string | null;
  agent_type: 'claude-code' | 'codex' | 'unknown';
  joined_at: string;
  last_activity?: string;
  persona?: string;
  capabilities?: string;
  status: 'busy' | 'idle' | 'dead' | 'unknown';
  token_usage?: TokenUsage | null;
  message_stats?: { sent: number; received: number };
  sweep?: {
    content_stable_ms: number;
    last_notified_at: string | null;
  } | null;
}

export interface Stats {
  agents: { busy: number; idle: number; dead: number; total: number };
  cost: {
    total_usd: number | null;
    total_input_tokens: number;
    total_output_tokens: number;
  };
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

export interface PaneMirror {
  room: string;
  agent: string;
  pane: string;
  status: 'idle' | 'busy' | 'unknown';
  typing_active: boolean;
  input_chars: number;
  content: string;
  captured_at: string;
}

export interface WsEvent {
  type:
    | 'message'
    | 'agent-status'
    | 'room-change'
    | 'template-change'
    | 'room-template-change'
    | 'pane-mirror';
  [key: string]: unknown;
}
