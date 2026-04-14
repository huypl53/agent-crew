import React from 'react';
import { Box, Text } from 'ink';
import type { Room, Message } from '../../shared/types.ts';
import type { AgentStatusEntry } from '../hooks/useStatus.ts';

export type RoomActionMode = 'menu' | 'create' | 'set-topic' | 'confirm-delete';

interface RoomOverlayProps {
  mode: RoomActionMode;
  selectedRoom: Room | null;
  rooms: Record<string, Room>;
  messages: Message[];
  statuses: Map<string, AgentStatusEntry>;
  inputValue: string;
  createStep: 'name' | 'topic';
  createName: string;
  createError: string;
  height: number;
}

function computeDeleteWarnings(room: Room, messages: Message[], statuses: Map<string, AgentStatusEntry>) {
  const memberCount = room.members.length;
  const busyAgents = room.members.filter(m => statuses.get(m)?.status === 'busy');
  const messageCount = messages.filter(m => m.room === room.name).length;
  return { memberCount, busyAgents, messageCount };
}

export { computeDeleteWarnings };

export function RoomOverlay({
  mode, selectedRoom, messages, statuses,
  inputValue, createStep, createName, createError, height,
}: RoomOverlayProps) {
  const warnings = selectedRoom && mode === 'confirm-delete'
    ? computeDeleteWarnings(selectedRoom, messages, statuses)
    : null;

  return (
    <Box flexDirection="column" borderStyle="single" height={height} justifyContent="center" alignItems="center">
      {mode === 'menu' && selectedRoom && (
        <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={0}>
          <Text bold> {selectedRoom.name} </Text>
          <Text>  [S] Set topic</Text>
          <Text>  [D] Delete room</Text>
          <Text dimColor>  [Esc] Cancel</Text>
        </Box>
      )}

      {mode === 'set-topic' && selectedRoom && (
        <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={0}>
          <Text bold> Set topic: {selectedRoom.name} </Text>
          <Text>  {'>'} {inputValue}_</Text>
          <Text dimColor>  Enter to save  Esc cancel</Text>
        </Box>
      )}

      {mode === 'create' && (
        <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={0}>
          <Text bold> Create room </Text>
          {createStep === 'name' ? (
            <>
              <Text>  Name: {inputValue}_</Text>
              {createError
                ? <Text color="red">  {createError}</Text>
                : <Text dimColor>  (letters, digits, - or _)</Text>}
            </>
          ) : (
            <>
              <Text dimColor>  Name: {createName}</Text>
              <Text>  Topic: {inputValue}_</Text>
              <Text dimColor>  (optional, Enter to skip)</Text>
            </>
          )}
          <Text dimColor>  Enter to confirm  Esc cancel</Text>
        </Box>
      )}

      {mode === 'confirm-delete' && selectedRoom && warnings && (
        <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={0}>
          <Text bold> Delete: {selectedRoom.name} </Text>
          {(warnings.memberCount > 0 || warnings.busyAgents.length > 0 || warnings.messageCount > 0) && (
            <>
              {warnings.memberCount > 0 && (
                <Text color="yellow" wrap="truncate">
                  {'  '}⚠  {warnings.memberCount} members will be removed: {selectedRoom.members.join(' ')}
                </Text>
              )}
              {warnings.busyAgents.length > 0 && (
                <Text color="red">
                  {'  '}⚠  {warnings.busyAgents.length} agents are currently BUSY
                </Text>
              )}
              {warnings.messageCount > 0 && (
                <Text color="yellow">
                  {'  '}⚠  {warnings.messageCount} messages will be deleted
                </Text>
              )}
              <Text> </Text>
            </>
          )}
          <Text>  Type room name to confirm: {inputValue}_</Text>
          {inputValue === selectedRoom.name && inputValue.length > 0 && (
            <Text color="green">  ✓ Press Enter to delete</Text>
          )}
          <Text dimColor>  Esc to cancel</Text>
        </Box>
      )}
    </Box>
  );
}
