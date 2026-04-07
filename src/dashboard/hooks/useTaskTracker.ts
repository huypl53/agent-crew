import { useMemo } from 'react';
import type { Message } from '../../shared/types.ts';

export interface TrackedTask {
  id: string;          // message_id of the task message
  text: string;        // truncated task text
  agent: string;       // assigned agent (message.to) or sender
  room: string;
  assignedAt: number;  // timestamp ms
  status: 'open' | 'done' | 'error';
  duration: number | null; // ms between task and completion/error, null if open
  closedBy?: string;   // message_id of completion/error
}

export function useTaskTracker(messages: Message[], room: string | null): TrackedTask[] {
  return useMemo(() => {
    if (!room) return [];

    const roomMsgs = messages.filter(m => m.room === room);
    const tasks: TrackedTask[] = [];

    // Collect all task messages
    for (const m of roomMsgs) {
      if (m.kind !== 'task') continue;
      tasks.push({
        id: m.message_id,
        text: m.text.length > 60 ? m.text.slice(0, 57) + '...' : m.text,
        agent: m.to ?? m.from,
        room: m.room,
        assignedAt: new Date(m.timestamp).getTime(),
        status: 'open',
        duration: null,
      });
    }

    // Match completions/errors to tasks
    // Strategy: for each completion/error, find the most recent open task
    // in the same room from/to the same agent
    for (const m of roomMsgs) {
      if (m.kind !== 'completion' && m.kind !== 'error') continue;
      const closeTime = new Date(m.timestamp).getTime();

      // Find best matching open task: same agent, most recent
      let bestMatch: TrackedTask | null = null;
      for (const t of tasks) {
        if (t.status !== 'open') continue;
        if (t.assignedAt > closeTime) continue;
        // Match by agent: task.agent matches completion sender
        if (t.agent === m.from || t.agent === m.to) {
          if (!bestMatch || t.assignedAt > bestMatch.assignedAt) {
            bestMatch = t;
          }
        }
      }

      // Fallback: match any open task in the room if no agent match
      if (!bestMatch) {
        for (const t of tasks) {
          if (t.status !== 'open') continue;
          if (t.assignedAt > closeTime) continue;
          if (!bestMatch || t.assignedAt > bestMatch.assignedAt) {
            bestMatch = t;
          }
        }
      }

      if (bestMatch) {
        bestMatch.status = m.kind === 'completion' ? 'done' : 'error';
        bestMatch.duration = closeTime - bestMatch.assignedAt;
        bestMatch.closedBy = m.message_id;
      }
    }

    // Sort: open first (oldest first), then completed (newest first)
    tasks.sort((a, b) => {
      if (a.status === 'open' && b.status !== 'open') return -1;
      if (a.status !== 'open' && b.status === 'open') return 1;
      if (a.status === 'open') return a.assignedAt - b.assignedAt; // oldest open first
      return b.assignedAt - a.assignedAt; // newest completed first
    });

    return tasks;
  }, [messages, room]);
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
