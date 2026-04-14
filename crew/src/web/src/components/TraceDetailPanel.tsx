import React, { useState } from 'react';
import type { TraceNode, TraceNodeStatus, Room, Agent, Task, TaskEvent, Message, TokenUsage } from '../types.ts';
import Breadcrumb from './Breadcrumb.tsx';

const STATUS_COLORS: Record<string, string> = {
  busy: 'text-status-busy', active: 'text-status-active',
  idle: 'text-status-idle', done: 'text-status-done',
  dead: 'text-status-dead', error: 'text-status-error',
  queued: 'text-status-queued', note: 'text-status-note',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="text-[10px] uppercase tracking-widest text-text-muted mb-0.5">{label}</div>
      <div className="text-text-primary text-xs">{children}</div>
    </div>
  );
}

function StatusPill({ status }: { status: TraceNodeStatus }) {
  if (!status) return <span className="text-text-muted">—</span>;
  return <span className={`font-semibold ${STATUS_COLORS[status] ?? 'text-text-muted'}`}>{status}</span>;
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

interface SectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}
function Section({ title, defaultOpen = true, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border">
      <button onClick={() => setOpen(o => !o)} className="flex items-center w-full px-3 py-2 text-xs hover:bg-panel transition-colors">
        <span className="text-text-secondary mr-2">{open ? '▾' : '▶'}</span>
        <span className="font-medium text-text-primary">{title}</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

function MonoBlock({ text, copyable = false }: { text: string; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard denied */ }
  };
  return (
    <div className="relative group">
      <pre className="whitespace-pre-wrap font-mono text-[10px] text-text-primary bg-canvas rounded p-2 mt-1 max-h-48 overflow-y-auto">
        {text}
      </pre>
      {copyable && (
        <button
          onClick={copy}
          className="absolute top-1 right-1 px-1.5 py-0.5 bg-panel hover:bg-panelElev text-[10px] text-text-secondary rounded opacity-0 group-hover:opacity-100 transition-opacity"
        >
          {copied ? '✓' : '📋'}
        </button>
      )}
    </div>
  );
}

// --- kind→tabs map ---

const TABS_BY_KIND: Record<string, string[]> = {
  root: ['Overview'],
  room: ['Members', 'Metadata'],
  agent: ['Stats', 'Cost', 'Metadata'],
  task: ['Instructions', 'Events', 'Metadata'],
  message: ['Input', 'Output', 'Metadata'],
};

// --- Per-kind content renderers ---

function RootContent({ node }: { node: TraceNode }) {
  const agentCount = (node.meta.agentCount as number | undefined)
    ?? node.children.filter(c => c.kind === 'agent').length;
  const taskCount = (node.meta.taskCount as number | undefined)
    ?? node.children.filter(c => c.kind === 'task').length;
  const msgCount = (node.meta.messageCount as number | undefined)
    ?? node.children.filter(c => c.kind === 'message').length;
  return (
    <div className="p-3 space-y-2">
      <Field label="Agents">{agentCount}</Field>
      <Field label="Tasks">{taskCount}</Field>
      <Field label="Messages">{msgCount}</Field>
      {node.durationMs != null && <Field label="Duration">{fmtMs(node.durationMs)}</Field>}
    </div>
  );
}

function RoomMembers({ node }: { node: TraceNode }) {
  const room = node.meta as unknown as Partial<Room>;
  return (
    <div className="p-3 space-y-2">
      {room.topic && <Field label="Topic">{room.topic}</Field>}
      <Field label="Members">
        {room.members?.length ? room.members.join(', ') : '—'}
      </Field>
      <Field label="Message count">{node.children.filter(c => c.kind === 'message').length || '—'}</Field>
    </div>
  );
}

function RoomMeta({ node }: { node: TraceNode }) {
  const room = node.meta as unknown as Partial<Room>;
  return (
    <div className="p-3 space-y-2">
      {room.created_at && <Field label="Created">{fmtTs(room.created_at)}</Field>}
      <Field label="Room name">#{node.label}</Field>
    </div>
  );
}

function AgentStats({ node }: { node: TraceNode }) {
  const agent = node.meta as unknown as Partial<Agent>;
  const ts = agent.task_stats;
  return (
    <div className="p-3 space-y-2">
      <Field label="Status"><StatusPill status={node.status} /></Field>
      {agent.role && <Field label="Role">{agent.role}</Field>}
      {agent.tmux_target && <Field label="Pane"><span className="font-mono text-[10px]">{agent.tmux_target}</span></Field>}
      {agent.rooms?.length ? <Field label="Rooms">{agent.rooms.join(', ')}</Field> : null}
      {ts && (
        <Field label="Tasks">
          <span className="text-status-done">{ts.done}</span> done ·{' '}
          <span className="text-status-active">{ts.active}</span> active ·{' '}
          <span className="text-status-queued">{ts.queued}</span> queued
          {ts.error > 0 && <> · <span className="text-status-error">{ts.error}</span> err</>}
        </Field>
      )}
      {agent.last_activity && <Field label="Last active">{fmtTs(agent.last_activity)}</Field>}
    </div>
  );
}

function AgentCost({ node }: { node: TraceNode }) {
  const agent = node.meta as unknown as Partial<Agent>;
  const tu = agent.token_usage as TokenUsage | null | undefined;
  if (!tu) return <div className="p-3 text-text-muted text-xs">No cost data</div>;
  return (
    <div className="p-3 space-y-2">
      {tu.model && <Field label="Model"><span className="font-mono text-[10px]">{tu.model}</span></Field>}
      <Field label="Tokens">
        <span className="font-nums text-text-primary">{tu.input_tokens.toLocaleString()}</span> in ·{' '}
        <span className="font-nums text-text-primary">{tu.output_tokens.toLocaleString()}</span> out
      </Field>
      {tu.cost_usd != null && (
        <Field label="Cost"><span className="text-status-done font-nums">${tu.cost_usd.toFixed(4)}</span></Field>
      )}
    </div>
  );
}

function AgentMeta({ node }: { node: TraceNode }) {
  const agent = node.meta as unknown as Partial<Agent>;
  return (
    <div className="p-3 space-y-2">
      {agent.persona && <Field label="Persona">{agent.persona}</Field>}
      {agent.capabilities && <Field label="Capabilities">{agent.capabilities}</Field>}
      <Field label="Agent ID">{agent.agent_id ?? '—'}</Field>
    </div>
  );
}

function TaskInstructions({ node }: { node: TraceNode }) {
  const task = node.meta as unknown as Partial<Task>;
  const text = task.text || task.note;
  return (
    <div className="p-3 space-y-2">
      <Field label="Status"><StatusPill status={node.status} /></Field>
      {task.assigned_to && <Field label="Assigned to">{task.assigned_to}</Field>}
      {task.created_by && <Field label="Created by">{task.created_by}</Field>}
      {task.room && <Field label="Room">#{task.room}</Field>}
      {node.durationMs != null && <Field label="Duration">{fmtMs(node.durationMs)}</Field>}
      {text && (
        <Field label="Text">
          <MonoBlock text={text} copyable />
        </Field>
      )}
    </div>
  );
}

function TaskEvents({ node }: { node: TraceNode }) {
  const task = node.meta as unknown as Partial<Task>;
  const events = (node.meta.events as TaskEvent[] | undefined) ?? [];
  const msgCount = node.children.filter(c => c.kind === 'message').length;
  return (
    <div className="p-3 space-y-2">
      <Field label="Task ID">#{task.id ?? node.id}</Field>
      {task.created_at && <Field label="Created">{fmtTs(task.created_at)}</Field>}
      {task.updated_at && <Field label="Updated">{fmtTs(task.updated_at)}</Field>}
      {msgCount > 0 && <Field label="Messages">{msgCount}</Field>}
      {events.length > 0 && (
        <Field label="Lifecycle">
          <ul className="space-y-1 mt-1">
            {events.map((e, i) => (
              <li key={e.id ?? i} className="text-[10px] text-text-secondary">
                <span className="text-text-muted">{fmtTs(e.timestamp)}</span>{' '}
                <span>{e.from_status ?? '—'} → {e.to_status}</span>
                {e.triggered_by && <span className="text-text-muted"> · {e.triggered_by}</span>}
              </li>
            ))}
          </ul>
        </Field>
      )}
    </div>
  );
}

function TaskMeta({ node }: { node: TraceNode }) {
  return (
    <div className="p-3 space-y-2">
      <Field label="Summary">{node.label}</Field>
      <Field label="Node ID">{node.id}</Field>
    </div>
  );
}

function MessageInput({ node }: { node: TraceNode }) {
  const msg = node.meta as unknown as Partial<Message>;
  return (
    <div className="p-3 space-y-2">
      <Field label="Kind">
        <span className="uppercase text-[10px] bg-panel text-text-secondary px-1.5 py-0.5 rounded">{msg.kind}</span>
      </Field>
      <Field label="From">{msg.from ?? '—'}</Field>
      {node.timestamp != null && <Field label="Time">{fmtTs(node.timestamp)}</Field>}
      {msg.reply_to != null && <Field label="Reply to">#{msg.reply_to}</Field>}
    </div>
  );
}

function MessageOutput({ node }: { node: TraceNode }) {
  const msg = node.meta as unknown as Partial<Message>;
  if (!msg.text) return <div className="p-3 text-text-muted text-xs">No text content</div>;
  return (
    <div className="p-3">
      <MonoBlock text={msg.text} copyable />
    </div>
  );
}

function MessageMeta({ node }: { node: TraceNode }) {
  const msg = node.meta as unknown as Partial<Message>;
  return (
    <div className="p-3 space-y-2">
      <Field label="To">{msg.to ?? '(room broadcast)'}</Field>
      <Field label="Sequence">{msg.sequence ?? '—'}</Field>
      <Field label="Message ID">{msg.message_id ?? node.id}</Field>
      <Field label="Room">#{msg.room ?? '—'}</Field>
    </div>
  );
}

// --- Tab router ---

interface TabContentProps {
  kind: string;
  tab: string;
  node: TraceNode;
}
function TabContent({ kind, tab, node }: TabContentProps) {
  // root
  if (kind === 'root' && tab === 'Overview') return <RootContent node={node} />;
  // room
  if (kind === 'room' && tab === 'Members') return <RoomMembers node={node} />;
  if (kind === 'room' && tab === 'Metadata') return <RoomMeta node={node} />;
  // agent
  if (kind === 'agent' && tab === 'Stats') return <AgentStats node={node} />;
  if (kind === 'agent' && tab === 'Cost') return <AgentCost node={node} />;
  if (kind === 'agent' && tab === 'Metadata') return <AgentMeta node={node} />;
  // task
  if (kind === 'task' && tab === 'Instructions') return <TaskInstructions node={node} />;
  if (kind === 'task' && tab === 'Events') return <TaskEvents node={node} />;
  if (kind === 'task' && tab === 'Metadata') return <TaskMeta node={node} />;
  // message
  if (kind === 'message' && tab === 'Input') return <MessageInput node={node} />;
  if (kind === 'message' && tab === 'Output') return <MessageOutput node={node} />;
  if (kind === 'message' && tab === 'Metadata') return <MessageMeta node={node} />;
  return <div className="p-3 text-text-muted text-xs">Unknown tab</div>;
}

// --- Main component ---

interface Props {
  node: TraceNode | null;
  ancestors?: TraceNode[];
  onAncestorSelect?: (node: TraceNode) => void;
}

export default function TraceDetailPanel({ node, ancestors = [], onAncestorSelect }: Props) {
  if (!node) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted text-xs bg-canvas">
        Select a node to inspect
      </div>
    );
  }

  const tabs = TABS_BY_KIND[node.kind] ?? ['Overview'];
  const [activeTab, setActiveTab] = useState(tabs[0]!);

  return (
    <div className="flex flex-col bg-canvas text-text-primary overflow-hidden">
      <Breadcrumb nodes={ancestors} onSelect={onAncestorSelect ?? (() => {})} />
      <div className="border-b border-border flex bg-panel">
        {tabs.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-accent text-accent'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        <TabContent kind={node.kind} tab={activeTab} node={node} />
      </div>
    </div>
  );
}
