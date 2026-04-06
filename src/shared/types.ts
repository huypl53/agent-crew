export type AgentRole = 'boss' | 'leader' | 'worker';
export type AgentStatus = 'idle' | 'busy' | 'dead' | 'unknown';

export interface Agent {
  agent_id: string;
  name: string;
  role: AgentRole;
  rooms: string[];
  tmux_target: string;
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
