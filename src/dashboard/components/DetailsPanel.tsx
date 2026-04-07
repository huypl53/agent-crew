import React, { memo } from 'react';
import { Box, Text } from 'ink';
import type { TreeNode } from '../hooks/useTree.ts';
import type { AgentStatusEntry } from '../hooks/useStatus.ts';
import type { Agent, Room, Message } from '../../shared/types.ts';
import { useTaskSummary } from '../hooks/useTaskSummary.ts';

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
  const taskSummary = useTaskSummary(messages, roomName);

  return (
    <Box flexDirection="column" borderStyle="single" height={height}>
      <Text bold> Details </Text>
      {isSyncing && !agent && <Text dimColor> Syncing...</Text>}
      {!agent && !isSyncing && selectedNode?.type === 'room' && (
        <RoomDetails node={selectedNode} room={rooms[selectedNode.label]} taskSummary={taskSummary} />
      )}
      {!agent && !isSyncing && !selectedNode && <Text dimColor> No agent selected</Text>}
      {agent && <AgentDetails agent={agent} status={agentStatus} rooms={rooms} height={height} />}
    </Box>
  );
});

function RoomDetails({ node, room, taskSummary }: { node: TreeNode; room?: Room; taskSummary: ReturnType<typeof useTaskSummary> }) {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>{node.label}</Text>
      {room?.topic && <Text>Topic: {room.topic}</Text>}
      <Text>Members: {node.memberCount}</Text>
      {taskSummary && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>─ Task Summary ─</Text>
          <Text>Tasks: {taskSummary.tasks}  <Text color="green">Done: {taskSummary.completed}</Text>  <Text color="red">Errors: {taskSummary.errors}</Text>  Open: {taskSummary.open}</Text>
          {taskSummary.questions > 0 && <Text color="yellow">Questions: {taskSummary.questions}</Text>}
        </Box>
      )}
    </Box>
  );
}

function AgentDetails({ agent, status, rooms, height }: { agent: Agent; status: AgentStatusEntry | null; rooms: Record<string, Room>; height: number }) {
  const s = status?.status ?? 'unknown';
  const color = STATUS_COLORS[s] ?? 'gray';
  const roomTopic = agent.rooms[0] ? rooms[agent.rooms[0]]?.topic : undefined;

  let ago = '';
  if (agent.last_activity) {
    const secs = Math.floor((Date.now() - new Date(agent.last_activity).getTime()) / 1000);
    ago = secs < 60 ? `${secs}s ago` : secs < 3600 ? `${Math.floor(secs / 60)}m ago` : `${Math.floor(secs / 3600)}h ago`;
  }

  const rawOutput = status?.rawOutput;
  const maxPaneLines = Math.max(0, height - 8);
  const paneLines = rawOutput
    ? rawOutput.split(/\r?\n/).map(l => l.replace(/\r/g, '')).filter(l => l.trim()).slice(-maxPaneLines).map(stripControlCodes)
    : [];

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>{agent.name}</Text>
      <Text><Text color={color}>{s}</Text>  <Text dimColor>{agent.role} · {agent.tmux_target}</Text></Text>
      <Text>Rooms: {agent.rooms.join(', ')}</Text>
      {roomTopic && <Text>Topic: {roomTopic}</Text>}
      {ago && <Text>Last: <Text dimColor>{ago}</Text></Text>}
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
