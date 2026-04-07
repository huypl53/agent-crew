import { useMemo } from 'react';
import type { Message } from '../../shared/types.ts';

export interface TaskSummary {
  tasks: number;
  completed: number;
  errors: number;
  questions: number;
  open: number;
}

export function useTaskSummary(messages: Message[], room: string | null): TaskSummary | null {
  return useMemo(() => {
    if (!room) return null;
    const roomMsgs = messages.filter(m => m.room === room);
    const tasks = roomMsgs.filter(m => m.kind === 'task').length;
    const completed = roomMsgs.filter(m => m.kind === 'completion').length;
    const errors = roomMsgs.filter(m => m.kind === 'error').length;
    const questions = roomMsgs.filter(m => m.kind === 'question').length;
    if (tasks === 0 && completed === 0 && errors === 0) return null;
    return { tasks, completed, errors, questions, open: Math.max(0, tasks - completed - errors) };
  }, [messages, room]);
}
