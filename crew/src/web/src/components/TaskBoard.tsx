import React, { useCallback, useEffect, useState } from 'react';
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

const ALL_STATUSES = [
  'active',
  'queued',
  'sent',
  'completed',
  'error',
  'cancelled',
  'interrupted',
] as TaskStatus[];

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

function fmtDateTime(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface TaskRowProps {
  task: Task;
}

function TaskRow({ task }: TaskRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<TaskEvent[] | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const toggle = useCallback(async () => {
    // Lazy-load detail on first expand
    if (!expanded && events === null && fetchError === null) {
      setLoadingDetail(true);
      try {
        const detail = await get<Task & { events: TaskEvent[] }>(
          `/tasks/${task.id}`,
        );
        setEvents(detail.events ?? []);
      } catch (e) {
        setFetchError(e instanceof Error ? e.message : 'Unknown error');
      } finally {
        setLoadingDetail(false);
      }
    }
    setExpanded((e) => !e);
  }, [expanded, events, fetchError, task.id]);

  const caret = expanded ? '▼' : '▶';

  return (
    <>
      {/* Task row — caret makes expandability obvious */}
      <tr
        className={`border-b border-slate-800 cursor-pointer transition-colors ${
          expanded
            ? 'bg-slate-800/60 hover:bg-slate-800/80'
            : 'hover:bg-slate-800/40'
        }`}
        onClick={toggle}
      >
        <td className="px-3 py-1.5 text-slate-500 text-xs w-4">
          <span className="text-slate-500 font-mono text-xs">{caret}</span>
        </td>
        <td className="px-2 py-1.5 text-slate-500 text-xs font-mono">
          #{task.id}
        </td>
        <td className="px-3 py-1.5">
          <StatusBadge status={task.status} />
        </td>
        <td className="px-3 py-1.5 text-slate-400 text-xs">{task.room}</td>
        <td className="px-3 py-1.5 text-slate-200 text-sm max-w-xs truncate">
          {task.summary}
        </td>
        <td className="px-3 py-1.5 text-slate-500 text-xs whitespace-nowrap">
          {elapsed(task.updated_at)} ago
        </td>
      </tr>

      {/* Expanded detail panel */}
      {expanded && (
        <tr className="bg-slate-900/60 border-b border-slate-700">
          <td colSpan={6} className="px-6 py-3">
            {loadingDetail && (
              <div className="text-xs text-slate-500 italic">
                Loading details…
              </div>
            )}
            {fetchError && (
              <div className="text-xs text-red-400">
                Failed to load details. {fetchError}
              </div>
            )}
            {!loadingDetail && !fetchError && (
              <div className="space-y-3 text-xs">
                {/* Full task instructions */}
                {task.text && (
                  <div>
                    <div className="text-slate-500 uppercase tracking-widest text-xs mb-1">
                      Instructions
                    </div>
                    <pre className="text-slate-200 font-mono whitespace-pre-wrap leading-relaxed border-l-2 border-slate-600 pl-3 text-xs">
                      {task.text}
                    </pre>
                  </div>
                )}

                {/* Metadata grid */}
                <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs">
                  <div>
                    <span className="text-slate-500">Task ID: </span>
                    <span className="text-slate-300 font-mono">#{task.id}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Status: </span>
                    <StatusBadge status={task.status} />
                  </div>
                  <div>
                    <span className="text-slate-500">Room: </span>
                    <span className="text-slate-300">#{task.room}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Assigned to: </span>
                    <span className="text-slate-300">{task.assigned_to}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Created by: </span>
                    <span className="text-slate-300">{task.created_by}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Created: </span>
                    <span className="text-slate-400 font-mono">
                      {fmtDateTime(task.created_at)}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">Updated: </span>
                    <span className="text-slate-400 font-mono">
                      {fmtDateTime(task.updated_at)}
                    </span>
                  </div>
                </div>

                {/* Lifecycle events */}
                <div>
                  <div className="text-slate-500 uppercase tracking-widest text-xs mb-1">
                    Lifecycle
                  </div>
                  {events === null && (
                    <div className="text-slate-600 italic">
                      No lifecycle events yet.
                    </div>
                  )}
                  {events !== null && events.length === 0 && (
                    <div className="text-slate-600 italic">
                      No lifecycle events yet.
                    </div>
                  )}
                  {events !== null && events.length > 0 && (
                    <div className="space-y-0.5 font-mono">
                      {events.map((ev) => (
                        <div key={ev.id} className="flex gap-3 text-xs">
                          <span className="text-slate-600 flex-shrink-0">
                            {fmtDateTime(ev.timestamp)}
                          </span>
                          <span>
                            <span
                              className={
                                STATUS_COLOR[ev.from_status ?? ''] ??
                                'text-slate-500'
                              }
                            >
                              {ev.from_status ?? 'init'}
                            </span>
                            <span className="text-slate-600"> → </span>
                            <span
                              className={
                                STATUS_COLOR[ev.to_status] ?? 'text-slate-400'
                              }
                            >
                              {ev.to_status}
                            </span>
                          </span>
                          {ev.triggered_by && (
                            <span className="text-slate-600">
                              by {ev.triggered_by}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
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
    const key = groupBy === 'agent' ? t.assigned_to || '(unassigned)' : t.room;
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
    setCollapsed((prev) => {
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
          {(['agent', 'room'] as GroupBy[]).map((g) => (
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
            onChange={(e) =>
              setStatusFilter(e.target.value as TaskStatus | 'all')
            }
            className="bg-slate-800 text-slate-200 text-xs px-2 py-0.5 rounded border border-slate-700"
          >
            <option value="all">all</option>
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <span className="text-xs text-slate-600 ml-auto">
          {tasks.length} task{tasks.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="px-4 py-8 text-slate-500 text-sm">Loading tasks…</div>
        )}
        {error && <div className="px-4 py-4 text-red-400 text-sm">{error}</div>}
        {!loading && !error && tasks.length === 0 && (
          <div className="px-4 py-8 text-slate-500 text-sm">
            No tasks found.
          </div>
        )}
        {!loading &&
          groups.map(({ key, tasks: groupTasks }) => (
            <div key={key}>
              <button
                onClick={() => toggleGroup(key)}
                className="w-full flex items-center gap-2 px-4 py-1.5 bg-slate-800/60 border-b border-slate-700 text-left hover:bg-slate-800"
              >
                <span className="text-xs text-slate-400">
                  {collapsed.has(key) ? '▶' : '▼'}
                </span>
                <span className="text-sm font-medium text-slate-200">
                  {key}
                </span>
                <span className="text-xs text-slate-500 ml-auto">
                  {groupTasks.length} task{groupTasks.length !== 1 ? 's' : ''}
                </span>
              </button>
              {!collapsed.has(key) && (
                <table className="w-full">
                  <tbody>
                    {groupTasks.map((t) => (
                      <TaskRow key={t.id} task={t} />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
