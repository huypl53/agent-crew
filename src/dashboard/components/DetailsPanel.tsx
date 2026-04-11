import React, { memo, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { TreeNode } from '../hooks/useTree.ts';
import type { AgentStatusEntry } from '../hooks/useStatus.ts';
import type { Agent, Room, Message, Task } from '../../shared/types.ts';
import { useTaskTracker, formatDuration, type TrackedTask } from '../hooks/useTaskTracker.ts';

const STATUS_COLORS: Record<string, string> = {
  idle: 'green', busy: 'yellow', dead: 'red', unknown: 'gray',
};

const TASK_ICONS: Record<string, { icon: string; color: string }> = {
  active: { icon: '●', color: 'yellow' },
  queued: { icon: '◌', color: 'gray' },
  sent: { icon: '→', color: 'cyan' },
  completed: { icon: '✓', color: 'green' },
  error: { icon: '✗', color: 'red' },
  cancelled: { icon: '⊘', color: 'gray' },
  interrupted: { icon: '⚡', color: 'magenta' },
};

function stripControlCodes(str: string): string {
  return str.replace(/\x1b\[[\d;]*[A-LN-Za-z]/g, '').replace(/\x1b[()][AB0-9]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

interface DetailsPanelProps {
  agent: Agent | null;
  agentStatus: AgentStatusEntry | null;
  selectedNode: TreeNode | null;
  rooms: Record<string, Room>;
  messages: Message[];
  tasks: Task[];
  isSyncing: boolean;
  height: number;
}

export const DetailsPanel = memo(function DetailsPanel({ agent, agentStatus, selectedNode, rooms, messages, tasks, isSyncing, height }: DetailsPanelProps) {
  const roomName = selectedNode?.type === 'room' ? selectedNode.label : null;
  const trackedTasks = useTaskTracker(tasks, roomName);

  return (
    <Box flexDirection="column" borderStyle="single" height={height}>
      <Text bold> Details </Text>
      {isSyncing && !agent && <Text dimColor> Syncing...</Text>}
      {!agent && !isSyncing && selectedNode?.type === 'room' && (
        <RoomDetails node={selectedNode} room={rooms[selectedNode.label]} trackedTasks={trackedTasks} />
      )}
      {!agent && !isSyncing && !selectedNode && <RoomOverview rooms={rooms} messages={messages} />}
      {agent && <AgentDetails agent={agent} status={agentStatus} rooms={rooms} messages={messages} height={height} />}
    </Box>
  );
});

function RoomOverview({ rooms, messages }: { rooms: Record<string, Room>; messages: Message[] }) {
  const roomStats = useMemo(() => {
    const stats: { name: string; members: number; tasks: number; done: number; errors: number; open: number; lastActive: string; lastTs: number }[] = [];

    for (const room of Object.values(rooms)) {
      let tasks = 0, done = 0, errors = 0, lastTs = 0;
      for (const m of messages) {
        if (m.room !== room.name) continue;
        const ts = new Date(m.timestamp).getTime();
        if (ts > lastTs) lastTs = ts;
        if (m.kind === 'task') tasks++;
        else if (m.kind === 'completion') done++;
        else if (m.kind === 'error') errors++;
      }

      let lastActive = '';
      if (lastTs > 0) {
        const secs = Math.floor((Date.now() - lastTs) / 1000);
        lastActive = secs < 60 ? `${secs}s ago` : secs < 3600 ? `${Math.floor(secs / 60)}m ago` : `${Math.floor(secs / 3600)}h ago`;
      }

      stats.push({
        name: room.name,
        members: room.members.length,
        tasks,
        done,
        errors,
        open: Math.max(0, tasks - done - errors),
        lastActive: lastActive || '-',
        lastTs,
      });
    }

    return stats.sort((a, b) => b.lastTs - a.lastTs);
  }, [rooms, messages]);

  if (roomStats.length === 0) {
    return <Text dimColor> No rooms yet</Text>;
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>Room Overview</Text>
      <Text dimColor>{'  Room             Members  Tasks  Done  Err  Open  Active'}</Text>
      {roomStats.map(r => (
        <Text key={r.name} wrap="truncate">
          {'  '}{r.name.padEnd(17).slice(0, 17)}
          {'  '}{String(r.members).padStart(3)}
          {'   '}{String(r.tasks).padStart(3)}
          {'  '}{String(r.done).padStart(4)}
          {'  '}<Text color={r.errors > 0 ? 'red' : undefined}>{String(r.errors).padStart(3)}</Text>
          {'  '}<Text color={r.open > 0 ? 'yellow' : undefined}>{String(r.open).padStart(4)}</Text>
          {'  '}<Text dimColor>{r.lastActive}</Text>
        </Text>
      ))}
    </Box>
  );
}

function RoomDetails({ node, room, trackedTasks }: { node: TreeNode; room?: Room; trackedTasks: TrackedTask[] }) {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>{node.label}</Text>
      {room?.topic && <Text>Topic: {room.topic}</Text>}
      <Text>Members: {node.memberCount}</Text>
      {trackedTasks.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>─ Tasks ─</Text>
          {trackedTasks.map(t => {
            const statusIcon = t.status === 'completed' ? '✓' : t.status === 'error' ? '✗' : t.status === 'interrupted' ? '⊘' : t.status === 'cancelled' ? '—' : '↻';
            const statusColor = t.status === 'completed' ? 'green' : t.status === 'error' ? 'red' : t.status === 'interrupted' ? 'magenta' : t.status === 'cancelled' ? 'gray' : 'yellow';
            const elapsed = t.duration != null
              ? formatDuration(t.duration)
              : formatDuration(Date.now() - t.assignedAt);
            return (
              <Text key={t.id} wrap="truncate">
                <Text color={statusColor}> {statusIcon} </Text>
                <Text>{t.text}</Text>
                <Text dimColor>  {t.agent}  {elapsed}</Text>
              </Text>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

function AgentDetails({ agent, status, rooms, messages, height }: { agent: Agent; status: AgentStatusEntry | null; rooms: Record<string, Room>; messages: Message[]; height: number }) {
  const s = status?.status ?? 'unknown';
  const color = STATUS_COLORS[s] ?? 'gray';
  const roomTopic = agent.rooms[0] ? rooms[agent.rooms[0]]?.topic : undefined;

  let ago = '';
  if (agent.last_activity) {
    const secs = Math.floor((Date.now() - new Date(agent.last_activity).getTime()) / 1000);
    ago = secs < 60 ? `${secs}s ago` : secs < 3600 ? `${Math.floor(secs / 60)}m ago` : `${Math.floor(secs / 3600)}h ago`;
  }

  const agentStats = useMemo(() => {
    let sent = 0, received = 0, tasksDone = 0, tasksError = 0;
    const durations: number[] = [];
    const openTasks: { assignedAt: number; matched: boolean }[] = [];

    // First pass: collect tasks assigned to this agent and count messages
    for (const m of messages) {
      if (m.from === agent.name) sent++;
      if (m.to === agent.name) {
        received++;
        if (m.kind === 'task') {
          openTasks.push({ assignedAt: new Date(m.timestamp).getTime(), matched: false });
        }
      }
    }

    // Second pass: match completions/errors to most-recent open task (same strategy as useTaskTracker)
    for (const m of messages) {
      if (m.from !== agent.name || (m.kind !== 'completion' && m.kind !== 'error')) continue;
      const closeTime = new Date(m.timestamp).getTime();
      let bestIdx = -1;
      for (let i = 0; i < openTasks.length; i++) {
        const t = openTasks[i]!;
        if (t.matched || t.assignedAt > closeTime) continue;
        if (bestIdx === -1 || t.assignedAt > openTasks[bestIdx]!.assignedAt) bestIdx = i;
      }
      if (bestIdx !== -1) {
        openTasks[bestIdx]!.matched = true;
        durations.push(closeTime - openTasks[bestIdx]!.assignedAt);
        if (m.kind === 'completion') tasksDone++;
        else tasksError++;
      }
    }
    const tasksOpen = openTasks.filter(t => !t.matched).length;

    const avgDuration = durations.length > 0
      ? Math.floor(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;

    let activeFor = '';
    if (agent.joined_at) {
      const secs = Math.floor((Date.now() - new Date(agent.joined_at).getTime()) / 1000);
      if (secs < 60) activeFor = `${secs}s`;
      else if (secs < 3600) activeFor = `${Math.floor(secs / 60)}m`;
      else {
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        activeFor = m > 0 ? `${h}h${m}m` : `${h}h`;
      }
    }

    return { sent, received, tasksDone, tasksError, tasksOpen, avgDuration, activeFor };
  }, [messages, agent.name, agent.joined_at]);

  // Memoize rawOutput processing — avoid re-running 3 regexes per line on every render
  const rawOutput = status?.rawOutput;
  const maxPaneLines = Math.max(0, height - 13);
  const paneLines = useMemo(() => {
    if (!rawOutput) return [];
    return rawOutput.split(/\r?\n/).map(l => l.replace(/\r/g, '')).filter(l => l.trim()).slice(-maxPaneLines).map(stripControlCodes);
  }, [rawOutput, maxPaneLines]);

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>{agent.name}</Text>
      <Text><Text color={color}>{s}</Text>  <Text dimColor>{agent.role} · {agent.tmux_target}</Text></Text>
      <Text>Rooms: {agent.rooms.join(', ')}</Text>
      {roomTopic && <Text>Topic: {roomTopic}</Text>}
      {ago && <Text>Last: <Text dimColor>{ago}</Text></Text>}
      {(agentStats.tasksDone > 0 || agentStats.tasksError > 0 || agentStats.tasksOpen > 0 || agentStats.sent > 0) && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>─ Stats ─</Text>
          {(agentStats.tasksDone > 0 || agentStats.tasksError > 0 || agentStats.tasksOpen > 0) && (
            <Text>
              Tasks: <Text color="green">{agentStats.tasksDone} done</Text>
              {agentStats.tasksError > 0 && <Text color="red">  {agentStats.tasksError} errors</Text>}
              {agentStats.tasksOpen > 0 && <Text color="yellow">  {agentStats.tasksOpen} open</Text>}
            </Text>
          )}
          {agentStats.avgDuration !== null && (
            <Text>Avg completion: <Text dimColor>{formatDuration(agentStats.avgDuration)}</Text></Text>
          )}
          <Text>Messages: {agentStats.sent} sent  {agentStats.received} received</Text>
          {agentStats.activeFor && <Text>Active: <Text dimColor>{agentStats.activeFor}</Text></Text>}
        </Box>
      )}
      {paneLines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>─ pane ─</Text>
          {paneLines.map((line, i) => (
            <Text key={i} dimColor wrap="truncate">{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
