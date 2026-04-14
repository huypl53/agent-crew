import React, { useEffect, useState, useCallback } from 'react';
import { get } from '../hooks/useApi.ts';
import type { Task, TaskEvent, TaskStatus } from '../types.ts';

type GroupBy = 'agent' | 'room';

const STATUS_ICON: Record<string, string> = {
  active: '●',
  completed: '✓',
  error: '✗',
  queued: '⏳',
  sent: '→',
  cancelled: '—',
  interrupted: '⚡',
};

const STATUS_COLOR: Record<string, string> = {
  active: 'text-blue-400',
  completed: 'text-green-400',
  error: 'text-red-400',
  queued: 'text-yellow-400',
  sent: 'text-slate-400',
  cancelled: 'text-slate-500',
  interrupted: 'text-orange-400',
};

const ALL_STATUSES = ['active', 'queued', 'sent', 'completed', 'error', 'cancelled', 'interrupted'] as TaskStatus[];

function StatusBadge({ status }: { status: string }) {
  const icon = STATUS_ICON[status] ?? '?';
  const color = STATUS_COLOR[status] ?? 'text-slate-400';
  return (
    <span className={`font-mono text-xs ${color}`} title={status}>
      {icon} {status}
    </span>
  );
}

function elapsed(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

interface TaskRowProps {
  task: Task;
}

function TaskRow({ task }: TaskRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<TaskEvent[] | null>(null);
  const [loadingEvents, setLoadingEvents] = useState(false);

  const expand = useCallback(async () => {
    if (!expanded && events === null) {
      setLoadingEvents(true);
      try {
        const detail = await get<Task & { events: TaskEvent[] }>(`/tasks/${task.id}`);
        setEvents(detail.events ?? []);
      } catch {
        setEvents([]);
      } finally {
        setLoadingEvents(false);
      }
    }
    setExpanded(e => !e);
  }, [expanded, events, task.id]);

  return (
    <>
      <tr
        className="border-b border-slate-800 hover:bg-slate-800/50 cursor-pointer"
        onClick={expand}
      >
        <td className="px-3 py-1.5 text-slate-500 text-xs font-mono">#{task.id}</td>
        <td className="px-3 py-1.5"><StatusBadge status={task.status} /></td>
        <td className="px-3 py-1.5 text-slate-400 text-xs">{task.room}</td>
        <td className="px-3 py-1.5 text-slate-200 text-sm max-w-xs truncate">{task.summary}</td>
        <td className="px-3 py-1.5 text-slate-500 text-xs">{elapsed(task.updated_at)} ago</td>
      </tr>
      {expanded && (
        <tr className="bg-slate-800/30">
          <td colSpan={5} className="px-4 py-2">
            {task.text && (
              <p className="text-slate-300 text-sm font-mono whitespace-pre-wrap mb-2 border-l-2 border-slate-600 pl-3">
                {task.text}
              </p>
            )}
            <div className="text-xs text-slate-500 mb-1">
              created by <span className="text-slate-400">{task.created_by}</span>
              {' · '}created {elapsed(task.created_at)} ago
            </div>
            {loadingEvents && <div className="text-xs text-slate-500">Loading events…</div>}
            {events && events.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {events.map(ev => (
                  <div key={ev.id} className="text-xs text-slate-500 font-mono">
                    {ev.timestamp.slice(0, 19).replace('T', ' ')}
                    {' · '}
                    <span className={STATUS_COLOR[ev.from_status ?? ''] ?? 'text-slate-400'}>{ev.from_status ?? '—'}</span>
                    {' → '}
                    <span className={STATUS_COLOR[ev.to_status] ?? 'text-slate-400'}>{ev.to_status}</span>
                    {ev.triggered_by && <span className="text-slate-600"> (by {ev.triggered_by})</span>}
                  </div>
                ))}
              </div>
            )}
            {events && events.length === 0 && (
              <div className="text-xs text-slate-600">No events recorded.</div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

interface GroupedTasks {
  key: string;
  tasks: Task[];
}

function groupTasks(tasks: Task[], groupBy: GroupBy): GroupedTasks[] {
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = groupBy === 'agent' ? (t.assigned_to || '(unassigned)') : t.room;
    const list = map.get(key) ?? [];
    list.push(t);
    map.set(key, list);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, tasks]) => ({ key, tasks }));
}

export default function TaskBoard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('agent');
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const fetchTasks = useCallback(async () => {
    try {
      const params = statusFilter !== 'all' ? `?status=${statusFilter}` : '';
      const data = await get<Task[]>(`/tasks${params}`);
      setTasks(data);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchTasks();
    const id = setInterval(fetchTasks, 5000);
    return () => clearInterval(id);
  }, [fetchTasks]);

  const toggleGroup = (key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const groups = groupTasks(tasks, groupBy);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-700 flex-shrink-0">
        <div className="flex items-center gap-1">
          <span className="text-xs text-slate-500">Group by:</span>
          {(['agent', 'room'] as GroupBy[]).map(g => (
            <button
              key={g}
              onClick={() => setGroupBy(g)}
              className={`px-2 py-0.5 text-xs rounded ${groupBy === g ? 'bg-slate-600 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {g}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs text-slate-500">Status:</span>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as TaskStatus | 'all')}
            className="bg-slate-800 text-slate-200 text-xs px-2 py-0.5 rounded border border-slate-700"
          >
            <option value="all">all</option>
            {ALL_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <span className="text-xs text-slate-600 ml-auto">{tasks.length} task{tasks.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading && <div className="px-4 py-8 text-slate-500 text-sm">Loading tasks…</div>}
        {error && <div className="px-4 py-4 text-red-400 text-sm">{error}</div>}
        {!loading && !error && tasks.length === 0 && (
          <div className="px-4 py-8 text-slate-500 text-sm">No tasks found.</div>
        )}
        {!loading && groups.map(({ key, tasks: groupTasks }) => (
          <div key={key}>
            <button
              onClick={() => toggleGroup(key)}
              className="w-full flex items-center gap-2 px-4 py-1.5 bg-slate-800/60 border-b border-slate-700 text-left hover:bg-slate-800"
            >
              <span className="text-xs text-slate-400">{collapsed.has(key) ? '▶' : '▼'}</span>
              <span className="text-sm font-medium text-slate-200">{key}</span>
              <span className="text-xs text-slate-500 ml-auto">{groupTasks.length} task{groupTasks.length !== 1 ? 's' : ''}</span>
            </button>
            {!collapsed.has(key) && (
              <table className="w-full">
                <tbody>
                  {groupTasks.map(t => <TaskRow key={t.id} task={t} />)}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
