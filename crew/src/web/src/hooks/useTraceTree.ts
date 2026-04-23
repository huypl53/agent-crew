import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Agent,
  Message,
  Room,
  Task,
  TraceNode,
  TraceNodeStatus,
} from '../types.ts';

// Extended Task shape from DB (includes message_id not in the frontend Task type)
type RawTask = Task & { message_id: number | null };

interface TracePayload {
  rooms: Room[];
  agents: Agent[];
  tasks: RawTask[];
  messages: Message[];
}

function toTaskStatus(s: string): TraceNodeStatus {
  const map: Record<string, TraceNodeStatus> = {
    queued: 'queued',
    active: 'active',
    completed: 'done',
    done: 'done',
    error: 'error',
    sent: 'note',
    cancelled: null,
    interrupted: null,
  };
  return map[s] ?? null;
}

function toAgentStatus(s: string): TraceNodeStatus {
  const map: Record<string, TraceNodeStatus> = {
    busy: 'busy',
    idle: 'idle',
    dead: 'dead',
    unknown: null,
  };
  return map[s] ?? null;
}

function parseTs(s: string | null | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Walk reply_to chain upward; return the root message id */
function findRoot(id: number, parentOf: Map<number, number>): number {
  let cur = id;
  for (let i = 0; i < 100; i++) {
    const p = parentOf.get(cur);
    if (p == null) return cur;
    cur = p;
  }
  return cur;
}

function buildTree(payload: TracePayload): TraceNode {
  const { rooms, agents, tasks, messages } = payload;

  // message_id → task
  const taskByRoot = new Map<number, RawTask>();
  for (const t of tasks) {
    if (t.message_id != null) taskByRoot.set(t.message_id, t);
  }

  // reply_to parent map (msgId → replyTo)
  const parentOf = new Map<number, number>();
  for (const m of messages) {
    if (m.reply_to != null) parentOf.set(Number(m.message_id), m.reply_to);
  }

  // assign each message to a task (via root) or fall back to agent by sender
  const msgsByTask = new Map<number, Message[]>(); // task.id → messages
  const msgsByAgent = new Map<string, Message[]>(); // agent.name → unassigned messages

  for (const msg of messages) {
    const rootId = findRoot(Number(msg.message_id), parentOf);
    const task = taskByRoot.get(rootId);
    if (task) {
      const arr = msgsByTask.get(task.id) ?? [];
      arr.push(msg);
      msgsByTask.set(task.id, arr);
    } else {
      const arr = msgsByAgent.get(msg.from) ?? [];
      arr.push(msg);
      msgsByAgent.set(msg.from, arr);
    }
  }

  // task.id → task node (memoised to avoid duplication across rooms)
  const agentSet = new Map<string, Agent>(agents.map((a) => [a.name, a]));

  function makeMessageNode(msg: Message): TraceNode {
    return {
      id: `msg:${msg.message_id}`,
      kind: 'message',
      iconKey: 'message',
      label: `${msg.from}→${msg.to ?? '*'}: ${msg.text.slice(0, 60)}`,
      status: null,
      timestamp: parseTs(msg.timestamp),
      durationMs: null,
      tokensIn: null,
      tokensOut: null,
      cost: null,
      children: [],
      meta: msg as unknown as Record<string, unknown>,
    };
  }

  function makeTaskNode(task: RawTask): TraceNode {
    const createdMs = Date.parse(task.created_at);
    const updatedMs = Date.parse(task.updated_at);
    const durationMs =
      !isNaN(createdMs) && !isNaN(updatedMs) ? updatedMs - createdMs : null;
    const msgs = (msgsByTask.get(task.id) ?? []).map(makeMessageNode);
    // Aggregate tokens from children (messages) - currently all null but structured for future
    const tokensIn =
      msgs.reduce((sum, m) => sum + (m.tokensIn ?? 0), 0) || null;
    const tokensOut =
      msgs.reduce((sum, m) => sum + (m.tokensOut ?? 0), 0) || null;
    const cost = msgs.reduce((sum, m) => sum + (m.cost ?? 0), 0) || null;
    return {
      id: `task:${task.id}`,
      kind: 'task',
      iconKey: 'task',
      label: `#${task.id} ${task.summary}`,
      status: toTaskStatus(task.status),
      timestamp: !isNaN(createdMs) ? Math.floor(createdMs / 1000) : null,
      durationMs,
      tokensIn,
      tokensOut,
      cost,
      children: msgs,
      meta: task as unknown as Record<string, unknown>,
    };
  }

  function makeAgentNode(agent: Agent, roomName: string): TraceNode {
    const agentTasks = tasks
      .filter((t) => t.assigned_to === agent.name && t.room === roomName)
      .map(makeTaskNode);
    // append unassigned messages for this agent in this room
    const unassigned = (msgsByAgent.get(agent.name) ?? [])
      .filter((m) => m.room === roomName)
      .map(makeMessageNode);
    const allChildren = [...agentTasks, ...unassigned];
    // Aggregate tokens: start with agent.token_usage if available, then add children sums
    const agentTokensIn = agent.token_usage?.input_tokens ?? null;
    const agentTokensOut = agent.token_usage?.output_tokens ?? null;
    const agentCost = agent.token_usage?.cost_usd ?? null;
    const childrenTokensIn =
      allChildren.reduce((sum, c) => sum + (c.tokensIn ?? 0), 0) || null;
    const childrenTokensOut =
      allChildren.reduce((sum, c) => sum + (c.tokensOut ?? 0), 0) || null;
    const childrenCost =
      allChildren.reduce((sum, c) => sum + (c.cost ?? 0), 0) || null;
    const tokensIn =
      agentTokensIn != null
        ? agentTokensIn + (childrenTokensIn ?? 0)
        : childrenTokensIn;
    const tokensOut =
      agentTokensOut != null
        ? agentTokensOut + (childrenTokensOut ?? 0)
        : childrenTokensOut;
    const cost =
      agentCost != null ? agentCost + (childrenCost ?? 0) : childrenCost;
    return {
      id: `agent:${roomName}:${agent.name}`,
      kind: 'agent',
      iconKey: 'agent',
      label: agent.name,
      status: toAgentStatus(agent.status),
      timestamp: null,
      durationMs: null,
      tokensIn,
      tokensOut,
      cost,
      children: allChildren,
      meta: agent as unknown as Record<string, unknown>,
    };
  }

  const roomNodes: TraceNode[] = rooms.map((room) => {
    const roomAgents = agents.filter((a) => a.room_name === room.name);
    const agentNodes = roomAgents.map((a) => makeAgentNode(a, room.name));
    const tokensIn =
      agentNodes.reduce((sum, a) => sum + (a.tokensIn ?? 0), 0) || null;
    const tokensOut =
      agentNodes.reduce((sum, a) => sum + (a.tokensOut ?? 0), 0) || null;
    const cost = agentNodes.reduce((sum, a) => sum + (a.cost ?? 0), 0) || null;
    return {
      id: `room:${room.name}`,
      kind: 'room',
      iconKey: 'room',
      label: `#${room.name}`,
      status: null,
      timestamp: parseTs(room.created_at),
      durationMs: null,
      tokensIn,
      tokensOut,
      cost,
      children: agentNodes,
      meta: room as unknown as Record<string, unknown>,
    };
  });

  const tokensIn =
    roomNodes.reduce((sum, r) => sum + (r.tokensIn ?? 0), 0) || null;
  const tokensOut =
    roomNodes.reduce((sum, r) => sum + (r.tokensOut ?? 0), 0) || null;
  const cost = roomNodes.reduce((sum, r) => sum + (r.cost ?? 0), 0) || null;
  return {
    id: 'root',
    kind: 'root',
    iconKey: 'root',
    label: 'Crew',
    status: null,
    timestamp: null,
    durationMs: null,
    tokensIn,
    tokensOut,
    cost,
    children: roomNodes,
    meta: {},
  };
}

export function useTraceTree(): {
  tree: TraceNode | null;
  loading: boolean;
  error: string | null;
} {
  const [payload, setPayload] = useState<TracePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const load = () => {
      fetch('/api/trace')
        .then((r) => r.json() as Promise<TracePayload>)
        .then((data) => {
          if (mountedRef.current) {
            setPayload(data);
            setLoading(false);
            setError(null);
          }
        })
        .catch((e) => {
          if (mountedRef.current) {
            setError(String(e));
            setLoading(false);
          }
        });
    };
    load();
    const id = setInterval(load, 10000);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, []);

  const tree = useMemo(() => (payload ? buildTree(payload) : null), [payload]);

  return { tree, loading, error };
}
