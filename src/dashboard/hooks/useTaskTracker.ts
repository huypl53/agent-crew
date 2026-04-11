import { useMemo } from 'react';
import type { Task, TaskStatus } from '../../shared/types.ts';

export interface TrackedTask {
  id: number;
  text: string;
  agent: string;
  room: string;
  assignedAt: number;
  status: TaskStatus;
  duration: number | null;
  updatedAt: number;
}

export function useTaskTracker(tasks: Task[], room: string | null): TrackedTask[] {
  return useMemo(() => {
    if (!room) return [];

    const roomTasks = tasks.filter(t => t.room === room);

    const tracked: TrackedTask[] = roomTasks.map(t => {
      const assignedAt = new Date(t.created_at).getTime();
      const updatedAt = new Date(t.updated_at).getTime();
      const isTerminal = ['completed', 'error', 'cancelled'].includes(t.status);
      const duration = isTerminal ? updatedAt - assignedAt : null;

      return {
        id: t.id,
        text: t.summary,
        agent: t.assigned_to,
        room: t.room,
        assignedAt,
        status: t.status,
        duration,
        updatedAt,
      };
    });

    // Sort: active first, then queued/sent, then terminal (newest first)
    const ORDER: Record<string, number> = {
      active: 0, queued: 1, sent: 2, interrupted: 3,
      completed: 4, error: 5, cancelled: 6,
    };

    tracked.sort((a, b) => {
      const oa = ORDER[a.status] ?? 9;
      const ob = ORDER[b.status] ?? 9;
      if (oa !== ob) return oa - ob;
      if (oa <= 3) return a.assignedAt - b.assignedAt; // active/queued: oldest first
      return b.updatedAt - a.updatedAt; // terminal: newest first
    });

    return tracked;
  }, [tasks, room]);
}

export function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  if (mins < 60) return remainSecs > 0 ? `${mins}m${remainSecs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hours}h${remainMins}m` : `${hours}h`;
}
