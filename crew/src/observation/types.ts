import type { AgentStatus } from '../shared/types.ts';
import type { InspectionTurn } from './claude-transcript.ts';

export type InspectionSource = 'transcript' | 'hook-events' | 'tmux-fallback';

export type DegradationReason =
  | 'none'
  | 'transcript_unavailable'
  | 'session_unresolved'
  | 'hook_only'
  | 'tmux_only';

export type BlockHint =
  | 'waiting_for_permission'
  | 'waiting_for_user_input'
  | 'running'
  | 'idle'
  | 'unknown';

export interface InspectionSnapshot {
  agent_name: string;
  room_name: string;
  provider: string;
  session_id: string | null;
  status: Extract<AgentStatus, 'busy' | 'idle' | 'unknown'>;
  updated_at: string | null;
  block_hint: BlockHint;
  source: InspectionSource;
  turns: InspectionTurn[];
  degraded: boolean;
  degradation_reason: DegradationReason;
}

export interface InspectWorkerParams {
  workerName: string;
  roomName: string;
  callerName: string;
  turns?: number;
}
