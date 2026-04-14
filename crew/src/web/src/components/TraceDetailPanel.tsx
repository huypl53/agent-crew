import React from 'react';
import type { TraceNode, TraceNodeStatus, Room, Agent, Task, TaskEvent, Message, TokenUsage } from '../types.ts';

const STATUS_COLORS: Record<string, string> = {
  busy: 'text-yellow-400', active: 'text-blue-400',
  idle: 'text-green-400', done: 'text-green-400',
  dead: 'text-red-400', error: 'text-red-400',
  queued: 'text-slate-400', note: 'text-slate-400',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-0.5">{label}</div>
      <div className="text-slate-300 text-xs">{children}</div>
    </div>
  );
}

function StatusPill({ status }: { status: TraceNodeStatus }) {
  if (!status) return <span className="text-slate-500">—</span>;
  return <span className={`font-semibold ${STATUS_COLORS[status] ?? 'text-slate-400'}`}>{status}</span>;
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function fmtTs(ts: number | string | null | undefined): string {
  if (ts == null) return '—';
  return new Date(ts).toLocaleString();
}

// --- Per-kind panels ---

function RootPanel({ node }: { node: TraceNode }) {
  const agentCount = (node.meta.agentCount as number | undefined)
    ?? node.children.filter(c => c.kind === 'agent').length;
  const taskCount = (node.meta.taskCount as number | undefined)
    ?? node.children.filter(c => c.kind === 'task').length;
  const msgCount = (node.meta.messageCount as number | undefined)
    ?? node.children.filter(c => c.kind === 'message').length;
  return (
    <>
      <div className="text-base font-semibold text-slate-200 mb-3">Crew</div>
      <Field label="Agents">{agentCount}</Field>
      <Field label="Tasks">{taskCount}</Field>
      <Field label="Messages">{msgCount}</Field>
      {node.durationMs != null && <Field label="Duration">{fmtMs(node.durationMs)}</Field>}
    </>
  );
}

function RoomPanel({ node }: { node: TraceNode }) {
  const room = node.meta as unknown as Partial<Room>;
  return (
    <>
      <div className="text-base font-semibold text-slate-200 mb-3">#{node.label}</div>
      {room.topic && <Field label="Topic">{room.topic}</Field>}
      <Field label="Members">
        {room.members?.length ? room.members.join(', ') : '—'}
      </Field>
      <Field label="Message count">{node.children.filter(c => c.kind === 'message').length || '—'}</Field>
      {room.created_at && <Field label="Created">{fmtTs(room.created_at)}</Field>}
    </>
  );
}

function AgentPanel({ node }: { node: TraceNode }) {
  const agent = node.meta as unknown as Partial<Agent>;
  const tu = agent.token_usage as TokenUsage | null | undefined;
  const ts = agent.task_stats;
  return (
    <>
      <div className="text-base font-semibold text-slate-200 mb-3">{node.label}</div>
      <Field label="Status"><StatusPill status={node.status} /></Field>
      {agent.role && <Field label="Role">{agent.role}</Field>}
      {agent.tmux_target && <Field label="Pane"><span className="font-mono text-[10px]">{agent.tmux_target}</span></Field>}
      {agent.rooms?.length ? <Field label="Rooms">{agent.rooms.join(', ')}</Field> : null}
      {ts && (
        <Field label="Tasks">
          <span className="text-green-400">{ts.done}</span> done ·{' '}
          <span className="text-blue-400">{ts.active}</span> active ·{' '}
          <span className="text-slate-400">{ts.queued}</span> queued
          {ts.error > 0 && <> · <span className="text-red-400">{ts.error}</span> err</>}
        </Field>
      )}
      {agent.last_activity && <Field label="Last active">{fmtTs(agent.last_activity)}</Field>}
      {tu && (
        <>
          <div className="border-t border-slate-700 my-2" />
          {tu.model && <Field label="Model"><span className="font-mono text-[10px]">{tu.model}</span></Field>}
          <Field label="Tokens">
            <span className="text-slate-200">{tu.input_tokens.toLocaleString()}</span> in ·{' '}
            <span className="text-slate-200">{tu.output_tokens.toLocaleString()}</span> out
          </Field>
          {tu.cost_usd != null && (
            <Field label="Cost"><span className="text-amber-400">${tu.cost_usd.toFixed(4)}</span></Field>
          )}
        </>
      )}
    </>
  );
}

function TaskPanel({ node }: { node: TraceNode }) {
  const task = node.meta as unknown as Partial<Task>;
  const events = (node.meta.events as TaskEvent[] | undefined) ?? [];
  const msgCount = node.children.filter(c => c.kind === 'message').length;
  return (
    <>
      <div className="text-base font-semibold text-slate-200 mb-3">Task #{task.id ?? node.id}</div>
      <Field label="Status"><StatusPill status={node.status} /></Field>
      {task.assigned_to && <Field label="Assigned to">{task.assigned_to}</Field>}
      {task.created_by && <Field label="Created by">{task.created_by}</Field>}
      {task.room && <Field label="Room">#{task.room}</Field>}
      {node.durationMs != null && <Field label="Duration">{fmtMs(node.durationMs)}</Field>}
      {msgCount > 0 && <Field label="Messages">{msgCount}</Field>}
      {task.created_at && <Field label="Created">{fmtTs(task.created_at)}</Field>}
      {task.updated_at && <Field label="Updated">{fmtTs(task.updated_at)}</Field>}
      {task.text && (
        <Field label="Text">
          <pre className="whitespace-pre-wrap font-mono text-[10px] text-slate-300 bg-slate-900 rounded p-2 mt-1 max-h-40 overflow-y-auto">{task.text}</pre>
        </Field>
      )}
      {events.length > 0 && (
        <Field label="Lifecycle">
          <ul className="space-y-1 mt-1">
            {events.map((e, i) => (
              <li key={e.id ?? i} className="text-[10px] text-slate-400">
                <span className="text-slate-500">{fmtTs(e.timestamp)}</span>{' '}
                <span>{e.from_status ?? '—'} → {e.to_status}</span>
                {e.triggered_by && <span className="text-slate-500"> · {e.triggered_by}</span>}
              </li>
            ))}
          </ul>
        </Field>
      )}
    </>
  );
}

function MessagePanel({ node }: { node: TraceNode }) {
  const msg = node.meta as unknown as Partial<Message>;
  return (
    <>
      <div className="text-base font-semibold text-slate-200 mb-3">Message</div>
      {msg.kind && (
        <Field label="Kind">
          <span className="uppercase text-[10px] bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded">{msg.kind}</span>
        </Field>
      )}
      <Field label="From → To">
        {msg.from ?? '—'} → {msg.to ?? '(room)'}
      </Field>
      {node.timestamp != null && <Field label="Time">{fmtTs(node.timestamp)}</Field>}
      {msg.reply_to != null && <Field label="Reply to">#{msg.reply_to}</Field>}
      {msg.text && (
        <Field label="Text">
          <pre className="whitespace-pre-wrap font-mono text-[10px] text-slate-300 bg-slate-900 rounded p-2 mt-1 max-h-48 overflow-y-auto">{msg.text}</pre>
        </Field>
      )}
    </>
  );
}

// --- Main component ---

interface Props {
  node: TraceNode | null;
}

export default function TraceDetailPanel({ node }: Props) {
  if (!node) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-600 text-xs">
        Select a node to inspect
      </div>
    );
  }

  let content: React.ReactNode;
  switch (node.kind) {
    case 'root':    content = <RootPanel node={node} />; break;
    case 'room':    content = <RoomPanel node={node} />; break;
    case 'agent':   content = <AgentPanel node={node} />; break;
    case 'task':    content = <TaskPanel node={node} />; break;
    case 'message': content = <MessagePanel node={node} />; break;
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 text-xs">
      {content}
    </div>
  );
}
