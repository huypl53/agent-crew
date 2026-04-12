import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Task, TaskEvent, Agent } from '../../shared/types.ts';
import { useActions } from '../hooks/useActions.ts';
import { ConfirmPrompt } from './ConfirmPrompt.tsx';
import { StatusFeedback } from './StatusFeedback.tsx';
import { InlineTextInput } from './InlineTextInput.tsx';
import { interruptTask, cancelTask, reassignTask } from '../actions/task-actions.ts';

type GroupBy = 'agent' | 'room';

interface GroupedTask {
  groupKey: string;
  groupName: string;
  tasks: Task[];
}

interface TaskBoardProps {
  tasks: Task[];
  taskEvents: TaskEvent[];
  agents: Agent[];
  height: number;
  width: number;
}

export function TaskBoard({ tasks, taskEvents, agents, height, width }: TaskBoardProps) {
  const [groupBy, setGroupBy] = useState<GroupBy>('agent');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedTaskId, setExpandedTaskId] = useState<number | null>(null);

  const {
    pendingAction, feedback, textInput,
    requestAction, confirm, cancel,
    showFeedback, requestTextInput, cancelTextInput,
    isBlocking,
  } = useActions();

  const agentMap = useMemo(() => new Map(agents.map(a => [a.name, a])), [agents]);

  const grouped = useMemo(() => {
    const groups: Map<string, Task[]> = new Map();
    for (const task of tasks) {
      const key = groupBy === 'agent' ? task.assigned_to : task.room;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(task);
    }

    const result: GroupedTask[] = [];
    for (const [key, groupTasks] of groups) {
      const name = groupBy === 'agent' ? agentMap.get(key)?.name ?? key : key;
      result.push({ groupKey: key, groupName: name, tasks: groupTasks.sort((a, b) => b.id - a.id) });
    }
    return result.sort((a, b) => a.groupName.localeCompare(b.groupName));
  }, [tasks, groupBy, agentMap]);

  // Flatten for navigation
  const allLines: Array<{ type: 'header'; group: GroupedTask } | { type: 'task'; task: Task; group: GroupedTask }> = [];
  for (const group of grouped) {
    allLines.push({ type: 'header', group });
    for (const task of group.tasks) {
      allLines.push({ type: 'task', task, group });
    }
  }

  const selectedLine = allLines[selectedIndex];
  const selectedTask = selectedLine?.type === 'task' ? selectedLine.task : null;

  const statusColor = (status: string): string => {
    if (status === 'completed') return 'green';
    if (status === 'active') return 'yellow';
    if (status === 'error') return 'red';
    if (status === 'queued' || status === 'sent') return 'cyan';
    return 'gray';
  };

  const getTaskDuration = (taskId: number): { from: string; to: string; totalMs: number } | null => {
    const events = taskEvents.filter(e => e.task_id === taskId).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    if (events.length < 2) return null;
    const from = events[0]!.timestamp;
    const to = events[events.length - 1]!.timestamp;
    const totalMs = new Date(to).getTime() - new Date(from).getTime();
    return { from, to, totalMs };
  };

  const formatDuration = (ms: number): string => {
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    return `${mins}m ${remSecs}s`;
  };

  const getTaskEvents = (taskId: number): TaskEvent[] => {
    return taskEvents.filter(e => e.task_id === taskId).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  };

  const renderTaskLine = (task: Task, isSelected: boolean): string => {
    const status = task.status;
    const duration = getTaskDuration(task.id);
    const durationStr = duration ? `(${formatDuration(duration.totalMs)})` : '';
    const contextPreview = task.context ? task.context.substring(0, 80) : '';
    const summary = task.summary.length > 40 ? task.summary.substring(0, 37) + '...' : task.summary;
    const prefix = isSelected ? '▶ ' : '  ';
    const statusChar = status === 'completed' ? '✓' : status === 'error' ? '✗' : status === 'active' ? '●' : '◌';
    const roomPrefix = `[${task.room}]`;
    return `${prefix}#${task.id} ${statusChar} ${status.padEnd(10)} ${roomPrefix.padEnd(8)} ${task.assigned_to.padEnd(10)} ${summary} ${durationStr} ${contextPreview}`;
  };

  useInput((input, key) => {
    // When text input is active, only handle Escape; let TextInput capture typing
    if (textInput) {
      if (key.escape) { cancelTextInput(); }
      return;
    }

    // When confirm prompt is active, handle y/n only
    if (pendingAction) {
      if (input === 'y') { confirm(); return; }
      if (input === 'n' || key.escape) { cancel(); return; }
      return;
    }

    // Normal navigation
    if (input === 'j' || key.downArrow) {
      setSelectedIndex(prev => Math.min(prev + 1, allLines.length - 1));
      return;
    }
    if (input === 'k' || key.upArrow) {
      setSelectedIndex(prev => Math.max(prev - 1, 0));
      return;
    }
    // 'g' toggles groupBy (was 'r' — freed up for reassign)
    if (input === 'g') {
      setGroupBy(prev => prev === 'agent' ? 'room' : 'agent');
      setSelectedIndex(0);
      return;
    }
    if (key.return && selectedLine?.type === 'task') {
      setExpandedTaskId(prev => prev === selectedLine.task.id ? null : selectedLine.task.id);
      return;
    }
    if (key.escape) {
      setExpandedTaskId(null);
      return;
    }

    // Task action hotkeys — only when a task line is selected
    if (!selectedTask) return;

    if (input === 'i' && selectedTask.status === 'active') {
      const task = selectedTask;
      requestAction({
        label: `Interrupt task #${task.id}?`,
        execute: async () => { await interruptTask(task); },
      });
      return;
    }

    if (input === 'd' && selectedTask.status === 'queued') {
      const task = selectedTask;
      requestAction({
        label: `Cancel task #${task.id}?`,
        execute: async () => { await cancelTask(task); },
      });
      return;
    }

    if (input === 'r' && (selectedTask.status === 'active' || selectedTask.status === 'queued')) {
      const task = selectedTask;
      requestTextInput(
        `Reassign #${task.id} (${task.assigned_to})`,
        (text) => {
          cancelTextInput();
          reassignTask(task, text).then(result => {
            showFeedback(result, 'success');
          }).catch(e => {
            showFeedback(`Error: ${e instanceof Error ? e.message : String(e)}`, 'error');
          });
        },
      );
      return;
    }
  });

  const visibleLines = Math.max(1, height - 3); // header line + status line

  const scrollOffset = Math.max(0, selectedIndex - Math.floor(visibleLines / 2));
  const visibleStart = scrollOffset;
  const visibleEnd = Math.min(allLines.length, visibleStart + visibleLines);

  // Build action hint for the status bar
  const actionHint = (() => {
    if (!selectedTask) return '';
    const hints: string[] = [];
    if (selectedTask.status === 'active') hints.push('[i]nterrupt', '[r]eassign');
    if (selectedTask.status === 'queued') hints.push('[d]elete', '[r]eassign');
    return hints.length > 0 ? '  ' + hints.join(' ') : '';
  })();

  return (
    <Box flexDirection="column" width={width} height={height} paddingLeft={1} paddingRight={1}>
      {/* Header */}
      <Box height={1}>
        <Text dimColor>
          Grouped by {groupBy === 'agent' ? 'Agent' : 'Room'} | [g] toggle group, [j/k] nav, [Enter] expand
        </Text>
      </Box>

      {/* Task list */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {allLines.slice(visibleStart, visibleEnd).map((line, idx) => {
          const actualIndex = visibleStart + idx;
          const isSelected = actualIndex === selectedIndex;
          const isExpanded = expandedTaskId === (line.type === 'task' ? line.task.id : null);

          if (line.type === 'header') {
            return (
              <Box key={`h-${line.group.groupKey}`} flexDirection="column">
                <Text bold dimColor>{line.group.groupName}</Text>
              </Box>
            );
          }

          const task = line.task;
          return (
            <Box key={`t-${task.id}`} flexDirection="column">
              <Text color={isSelected ? 'cyan' : 'default'}>
                {renderTaskLine(task, isSelected)}
              </Text>
              {isExpanded && (
                <Box flexDirection="column" paddingLeft={2} borderLeft borderStyle="single" borderColor="gray">
                  <Text dimColor>Summary:     {task.summary}</Text>
                  <Text dimColor>Status:      <Text color={statusColor(task.status)}>{task.status}</Text></Text>
                  <Text dimColor>Assigned to: {task.assigned_to}</Text>
                  <Text dimColor>Created by:  {task.created_by}</Text>
                  <Text dimColor>Room:        {task.room}</Text>
                  <Text dimColor>Created at:  {new Date(task.created_at).toLocaleString()}</Text>
                  <Text dimColor>Updated at:  {new Date(task.updated_at).toLocaleString()}</Text>
                  {task.message_id != null && <Text dimColor>Message ID:  {task.message_id}</Text>}
                  {task.note && <Text dimColor>Note:        {task.note}</Text>}
                  {task.context && <Text dimColor>Context:     {task.context}</Text>}
                  <Text dimColor>Status History:</Text>
                  {getTaskEvents(task.id).map((evt, i) => (
                    <Text key={i} dimColor>
                      {' '}{new Date(evt.timestamp).toLocaleTimeString()} {evt.from_status ?? 'init'} → {evt.to_status} ({evt.triggered_by ?? 'system'})
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Status bar — shows action UI when blocking, otherwise position + hints */}
      <Box height={1}>
        {textInput ? (
          <InlineTextInput prompt={textInput.prompt} onSubmit={textInput.onSubmit} onCancel={cancelTextInput} />
        ) : pendingAction ? (
          <ConfirmPrompt action={pendingAction} />
        ) : feedback ? (
          <StatusFeedback text={feedback.text} type={feedback.type} />
        ) : (
          <Text dimColor>{selectedIndex + 1} of {allLines.length}{actionHint}</Text>
        )}
      </Box>
    </Box>
  );
}
