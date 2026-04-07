import React, { memo, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { TreeNode } from '../hooks/useTree.ts';
import type { AgentStatusEntry } from '../hooks/useStatus.ts';
import type { Agent, Room, Message } from '../../shared/types.ts';
import { useTaskTracker, formatDuration, type TrackedTask } from '../hooks/useTaskTracker.ts';

const STATUS_COLORS: Record<string, string> = {
  idle: 'green', busy: 'yellow', dead: 'red', unknown: 'gray',
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
  isSyncing: boolean;
  height: number;
}

export const DetailsPanel = memo(function DetailsPanel({ agent, agentStatus, selectedNode, rooms, messages, isSyncing, height }: DetailsPanelProps) {
  const roomName = selectedNode?.type === 'room' ? selectedNode.label : null;
  const trackedTasks = useTaskTracker(messages, roomName);

  return (
    <Box flexDirection="column" borderStyle="single" height={height}>
      <Text bold> Details </Text>
      {isSyncing && !agent && <Text dimColor> Syncing...</Text>}
      {!agent && !isSyncing && selectedNode?.type === 'room' && (
        <RoomDetails node={selectedNode} room={rooms[selectedNode.label]} trackedTasks={trackedTasks} />
      )}
      {!agent && !isSyncing && !selectedNode && <Text dimColor> No agent selected</Text>}
      {agent && <AgentDetails agent={agent} status={agentStatus} rooms={rooms} messages={messages} height={height} />}
    </Box>
  );
});

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
            const statusIcon = t.status === 'done' ? '✓' : t.status === 'error' ? '✗' : '↻';
            const statusColor = t.status === 'done' ? 'green' : t.status === 'error' ? 'red' : 'yellow';
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
    let sent = 0, received = 0, tasksDone = 0, tasksError = 0, tasksOpen = 0;
    const durations: number[] = [];
    const openTasks: { assignedAt: number }[] = [];

    for (const m of messages) {
      if (m.from === agent.name) sent++;
      if (m.to === agent.name) {
        received++;
        if (m.kind === 'task') {
          openTasks.push({ assignedAt: new Date(m.timestamp).getTime() });
        }
      }
      if (m.from === agent.name && (m.kind === 'completion' || m.kind === 'error')) {
        const task = openTasks.shift();
        if (task) {
          const dur = new Date(m.timestamp).getTime() - task.assignedAt;
          durations.push(dur);
          if (m.kind === 'completion') tasksDone++;
          else tasksError++;
        }
      }
    }
    tasksOpen = openTasks.length;

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
