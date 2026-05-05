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
  role: 'boss' | 'leader' | 'worker';
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
  role: 'boss' | 'leader' | 'worker';
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
  task_stats?: { done: number; active: number; queued: number; error: number };
  sweep?: {
    content_stable_ms: number;
    last_notified_at: string | null;
  } | null;
}

export interface Stats {
  agents: { busy: number; idle: number; dead: number; total: number };
  tasks: {
    done: number;
    active: number;
    queued: number;
    error: number;
    total: number;
  };
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

export type TaskStatus =
  | 'sent'
  | 'queued'
  | 'active'
  | 'completed'
  | 'error'
  | 'cancelled'
  | 'interrupted';

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
    | 'task-update'
    | 'agent-status'
    | 'room-change'
    | 'template-change'
    | 'room-template-change'
    | 'pane-mirror';
  [key: string]: unknown;
}

export type TraceNodeKind = 'root' | 'room' | 'agent' | 'task' | 'message' | 'turn';

export interface CanonicalTraceSpan {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  room: string;
  agent: string | null;
  status: string;
  kind: 'message_turn' | 'task' | 'message' | 'event';
  started_at: string;
  ended_at: string | null;
  attributes: Record<string, unknown>;
}

export interface TraceEventLink {
  source_span_id: string;
  target_span_id: string;
  relation: 'parent' | 'reply_to' | 'status_transition' | 'inferred';
}

export interface TraceTurnGroup {
  turn_id: string;
  room: string;
  agent: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  span_ids: string[];
  before_span_ids: string[];
  after_span_ids: string[];
  parallel_turn_ids: string[];
}

export interface TraceTimelinePayload {
  spans: CanonicalTraceSpan[];
  turns: TraceTurnGroup[];
  links: TraceEventLink[];
}

export interface TraceTimelineFilters {
  room?: string;
  agent?: string;
  status?: string;
  from?: string;
  to?: string;
}

export interface TraceTimelineRow {
  turn: TraceTurnGroup;
  spans: CanonicalTraceSpan[];
  links: TraceEventLink[];
}

export interface TraceTimelineViewModel {
  rows: TraceTimelineRow[];
}

export interface TraceWaterfallRow {
  row_id: string;
  turn_id: string;
  span_id: string;
  label: string;
  status: string;
  room: string;
  agent: string | null;
  started_at: string;
  ended_at: string | null;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  parent_span_id: string | null;
}

export interface TraceWaterfallViewModel {
  min_start_ms: number;
  max_end_ms: number;
  total_ms: number;
  rows: TraceWaterfallRow[];
}

export interface TraceDagNode {
  id: string;
  span_id: string;
  label: string;
  room: string;
  agent: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
}

export interface TraceDagEdge {
  id: string;
  source: string;
  target: string;
  relation: TraceEventLink['relation'];
}

export interface TraceDagViewModel {
  nodes: TraceDagNode[];
  edges: TraceDagEdge[];
}

export type TraceSelection = {
  turnId: string | null;
  spanId: string | null;
};

export type TraceTimelineSortKey = {
  startedAtMs: number;
  endedAtMs: number;
  turnId: string;
};

export function parseIsoMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

export function compareTraceTimelineSortKey(
  a: TraceTimelineSortKey,
  b: TraceTimelineSortKey,
): number {
  if (a.startedAtMs !== b.startedAtMs) return a.startedAtMs - b.startedAtMs;
  if (a.endedAtMs !== b.endedAtMs) return a.endedAtMs - b.endedAtMs;
  return a.turnId.localeCompare(b.turnId);
}

export function buildTraceTimelineViewModel(
  payload: TraceTimelinePayload,
): TraceTimelineViewModel {
  const spanById = new Map(payload.spans.map((span) => [span.span_id, span]));
  const rows = payload.turns
    .map((turn) => {
      const spans = turn.span_ids
        .map((id) => spanById.get(id))
        .filter((span): span is CanonicalTraceSpan => Boolean(span));
      const spanIds = new Set(spans.map((span) => span.span_id));
      const links = payload.links.filter(
        (link) => spanIds.has(link.source_span_id) || spanIds.has(link.target_span_id),
      );
      return { turn, spans, links };
    })
    .sort((a, b) =>
      compareTraceTimelineSortKey(
        {
          startedAtMs: parseIsoMs(a.turn.started_at),
          endedAtMs: parseIsoMs(a.turn.ended_at ?? a.turn.started_at),
          turnId: a.turn.turn_id,
        },
        {
          startedAtMs: parseIsoMs(b.turn.started_at),
          endedAtMs: parseIsoMs(b.turn.ended_at ?? b.turn.started_at),
          turnId: b.turn.turn_id,
        },
      ),
    );
  return { rows };
}

export function buildTraceWaterfallViewModel(
  payload: TraceTimelinePayload,
): TraceWaterfallViewModel {
  const spanById = new Map(payload.spans.map((span) => [span.span_id, span]));
  const rows: TraceWaterfallRow[] = [];
  let minStartMs = Number.POSITIVE_INFINITY;
  let maxEndMs = Number.NEGATIVE_INFINITY;
  for (const turn of payload.turns) {
    for (const spanId of turn.span_ids) {
      const span = spanById.get(spanId);
      if (!span) continue;
      const startMs = parseIsoMs(span.started_at);
      const endMs = parseIsoMs(span.ended_at ?? span.started_at);
      const normalizedEndMs = endMs >= startMs ? endMs : startMs;
      minStartMs = Math.min(minStartMs, startMs);
      maxEndMs = Math.max(maxEndMs, normalizedEndMs);
      rows.push({
        row_id: `${turn.turn_id}:${span.span_id}`,
        turn_id: turn.turn_id,
        span_id: span.span_id,
        label: `${turn.room} · ${turn.agent ?? 'unknown'}`,
        status: span.status,
        room: turn.room,
        agent: turn.agent,
        started_at: span.started_at,
        ended_at: span.ended_at,
        start_ms: startMs,
        end_ms: normalizedEndMs,
        duration_ms: Math.max(0, normalizedEndMs - startMs),
        parent_span_id: span.parent_span_id,
      });
    }
  }
  rows.sort((a, b) => {
    if (a.start_ms !== b.start_ms) return a.start_ms - b.start_ms;
    if (a.end_ms !== b.end_ms) return a.end_ms - b.end_ms;
    return a.row_id.localeCompare(b.row_id);
  });
  if (rows.length === 0 || !Number.isFinite(minStartMs) || !Number.isFinite(maxEndMs)) {
    return { min_start_ms: 0, max_end_ms: 0, total_ms: 0, rows: [] };
  }
  return {
    min_start_ms: minStartMs,
    max_end_ms: maxEndMs,
    total_ms: Math.max(1, maxEndMs - minStartMs),
    rows,
  };
}

export function buildTraceDagViewModel(payload: TraceTimelinePayload): TraceDagViewModel {
  const nodeMap = new Map<string, TraceDagNode>();
  for (const span of payload.spans) {
    nodeMap.set(span.span_id, {
      id: span.span_id,
      span_id: span.span_id,
      label: `${span.room} · ${span.agent ?? 'unknown'}`,
      room: span.room,
      agent: span.agent,
      status: span.status,
      started_at: span.started_at,
      ended_at: span.ended_at,
    });
  }
  const edgeMap = new Map<string, TraceDagEdge>();
  for (const span of payload.spans) {
    if (!span.parent_span_id || !nodeMap.has(span.parent_span_id)) continue;
    const edgeId = `parent:${span.parent_span_id}->${span.span_id}`;
    edgeMap.set(edgeId, {
      id: edgeId,
      source: span.parent_span_id,
      target: span.span_id,
      relation: 'parent',
    });
  }
  for (const link of payload.links) {
    if (!nodeMap.has(link.source_span_id) || !nodeMap.has(link.target_span_id)) continue;
    const edgeId = `${link.relation}:${link.source_span_id}->${link.target_span_id}`;
    edgeMap.set(edgeId, {
      id: edgeId,
      source: link.source_span_id,
      target: link.target_span_id,
      relation: link.relation,
    });
  }
  const nodes = Array.from(nodeMap.values()).sort((a, b) =>
    a.span_id.localeCompare(b.span_id),
  );
  const edges = Array.from(edgeMap.values()).sort((a, b) => a.id.localeCompare(b.id));
  return { nodes, edges };
}
export type TraceNodeStatus =
  | 'queued'
  | 'active'
  | 'done'
  | 'error'
  | 'idle'
  | 'busy'
  | 'dead'
  | 'note'
  | null;
export interface TraceNode {
  id: string; // unique, e.g. 'room:crew', 'agent:wk-01', 'task:42', 'msg:abc'
  kind: TraceNodeKind;
  iconKey: string; // maps to kind: 'root' | 'room' | 'agent' | 'task' | 'message'
  label: string;
  status: TraceNodeStatus;
  timestamp: number | null; // unix seconds of node's primary time
  durationMs: number | null; // null if unknown
  tokensIn: number | null; // aggregated input tokens (null if unknown)
  tokensOut: number | null; // aggregated output tokens (null if unknown)
  cost: number | null; // aggregated cost in USD (null if unknown)
  children: TraceNode[];
  meta: Record<string, unknown>; // raw backing row (Room / AgentInfo / Task / Message)
}
