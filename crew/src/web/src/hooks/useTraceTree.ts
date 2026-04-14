import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Message, Room, Task, TraceNode, TraceNodeStatus } from '../types.ts';

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
    queued: 'queued', active: 'active', completed: 'done', done: 'done',
    error: 'error', sent: 'note', cancelled: null, interrupted: null,
  };
  return map[s] ?? null;
}

function toAgentStatus(s: string): TraceNodeStatus {
  const map: Record<string, TraceNodeStatus> = {
    busy: 'busy', idle: 'idle', dead: 'dead',
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
  const msgsByTask = new Map<number, Message[]>();   // task.id → messages
  const msgsByAgent = new Map<string, Message[]>();  // agent.name → unassigned messages

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
  const agentSet = new Map<string, Agent>(agents.map(a => [a.name, a]));

  function makeMessageNode(msg: Message): TraceNode {
    return {
      id: `msg:${msg.message_id}`,
      kind: 'message',
      label: `${msg.from}→${msg.to ?? '*'}: ${msg.text.slice(0, 60)}`,
      status: null,
      timestamp: parseTs(msg.timestamp),
      durationMs: null,
      children: [],
      meta: msg as unknown as Record<string, unknown>,
    };
  }

  function makeTaskNode(task: RawTask): TraceNode {
    const createdMs = Date.parse(task.created_at);
    const updatedMs = Date.parse(task.updated_at);
    const durationMs = !isNaN(createdMs) && !isNaN(updatedMs) ? updatedMs - createdMs : null;
    const msgs = (msgsByTask.get(task.id) ?? []).map(makeMessageNode);
    return {
      id: `task:${task.id}`,
      kind: 'task',
      label: `#${task.id} ${task.summary}`,
      status: toTaskStatus(task.status),
      timestamp: !isNaN(createdMs) ? Math.floor(createdMs / 1000) : null,
      durationMs,
      children: msgs,
      meta: task as unknown as Record<string, unknown>,
    };
  }

  function makeAgentNode(agent: Agent, roomName: string): TraceNode {
    const agentTasks = tasks
      .filter(t => t.assigned_to === agent.name && t.room === roomName)
      .map(makeTaskNode);
    // append unassigned messages for this agent in this room
    const unassigned = (msgsByAgent.get(agent.name) ?? [])
      .filter(m => m.room === roomName)
      .map(makeMessageNode);
    return {
      id: `agent:${roomName}:${agent.name}`,
      kind: 'agent',
      label: agent.name,
      status: toAgentStatus(agent.status),
      timestamp: null,
      durationMs: null,
      children: [...agentTasks, ...unassigned],
      meta: agent as unknown as Record<string, unknown>,
    };
  }

  const roomNodes: TraceNode[] = rooms.map(room => {
    const roomAgents = agents.filter(a => a.rooms.includes(room.name));
    return {
      id: `room:${room.name}`,
      kind: 'room',
      label: `#${room.name}`,
      status: null,
      timestamp: parseTs(room.created_at),
      durationMs: null,
      children: roomAgents.map(a => makeAgentNode(a, room.name)),
      meta: room as unknown as Record<string, unknown>,
    };
  });

  return {
    id: 'root',
    kind: 'root',
    label: 'Crew',
    status: null,
    timestamp: null,
    durationMs: null,
    children: roomNodes,
    meta: {},
  };
}

export function useTraceTree(): { tree: TraceNode | null; loading: boolean; error: string | null } {
  const [payload, setPayload] = useState<TracePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const load = () => {
      fetch('/api/trace')
        .then(r => r.json() as Promise<TracePayload>)
        .then(data => { if (mountedRef.current) { setPayload(data); setLoading(false); setError(null); } })
        .catch(e => { if (mountedRef.current) { setError(String(e)); setLoading(false); } });
    };
    load();
    const id = setInterval(load, 10000);
    return () => { mountedRef.current = false; clearInterval(id); };
  }, []);

  const tree = useMemo(() => (payload ? buildTree(payload) : null), [payload]);

  return { tree, loading, error };
}
