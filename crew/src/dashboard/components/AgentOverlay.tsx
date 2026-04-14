import React from 'react';
import { Box, Text } from 'ink';
import type { Agent } from '../../shared/types.ts';
import type { AgentStatusEntry } from '../hooks/useStatus.ts';

export type AgentActionMode = 'menu' | 'edit-persona' | 'edit-capabilities' | 'confirm-remove' | 'confirm-delete';

interface AgentOverlayProps {
  mode: AgentActionMode;
  agent: Agent | null;
  selectedRoomName: string | null;
  statuses: Map<string, AgentStatusEntry>;
  inputValue: string;
  overlayError: string;
  height: number;
}

/** Parse comma-separated capability string for display/edit */
export function parseCapabilities(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/** Parse stored JSON capabilities string to comma-separated display string */
export function capabilitiesToInput(stored: string | undefined): string {
  if (!stored) return '';
  try {
    const arr = JSON.parse(stored) as string[];
    return Array.isArray(arr) ? arr.join(', ') : stored;
  } catch {
    return stored;
  }
}

export function AgentOverlay({
  mode, agent, selectedRoomName, statuses, inputValue, overlayError, height,
}: AgentOverlayProps) {
  if (!agent) return null;

  const isBusy = statuses.get(agent.name)?.status === 'busy';
  const confirmed = mode === 'confirm-delete' && inputValue === agent.name && inputValue.length > 0;

  return (
    <Box flexDirection="column" borderStyle="single" height={height} justifyContent="center" alignItems="center">
      {mode === 'menu' && (
        <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={0}>
          <Text bold> {agent.name} ({agent.role}) </Text>
          <Text>  [P] Edit persona</Text>
          <Text>  [C] Edit capabilities</Text>
          <Text>  [R] Remove from room</Text>
          <Text>  [D] Delete agent</Text>
          <Text dimColor>  [Esc] Cancel</Text>
        </Box>
      )}

      {mode === 'edit-persona' && (
        <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={0}>
          <Text bold> Persona: {agent.name} </Text>
          <Text>  {'>'} {inputValue}_</Text>
          <Text> </Text>
          {overlayError && <Text color="red">  {overlayError}</Text>}
          <Text dimColor>  Enter to save  Esc cancel</Text>
        </Box>
      )}

      {mode === 'edit-capabilities' && (
        <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={0}>
          <Text bold> Capabilities: {agent.name} </Text>
          <Text>  {'>'} {inputValue}_</Text>
          <Text dimColor>  (comma-separated)</Text>
          {overlayError && <Text color="red">  {overlayError}</Text>}
          <Text dimColor>  Enter to save  Esc cancel</Text>
        </Box>
      )}

      {mode === 'confirm-remove' && (
        <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={0}>
          <Text bold> Remove from room </Text>
          <Text>  Remove {agent.name} from {selectedRoomName ?? '?'}?</Text>
          {isBusy && (
            <>
              <Text> </Text>
              <Text color="yellow">  ⚠  Agent is currently BUSY</Text>
            </>
          )}
          <Text> </Text>
          {overlayError && <Text color="red">  {overlayError}</Text>}
          <Text dimColor>  y confirm  Esc cancel</Text>
        </Box>
      )}

      {mode === 'confirm-delete' && (
        <Box flexDirection="column" borderStyle="single" paddingX={2} paddingY={0}>
          <Text bold> Delete agent </Text>
          {isBusy && <Text color="yellow">  ⚠  Agent is currently BUSY</Text>}
          {agent.rooms.length > 0 && (
            <Text color="yellow" wrap="truncate">
              {'  '}⚠  Member of {agent.rooms.length} room{agent.rooms.length !== 1 ? 's' : ''}: {agent.rooms.join(' ')}
            </Text>
          )}
          <Text> </Text>
          <Text>  Type agent name to confirm: {inputValue}_</Text>
          {confirmed && <Text color="green">  ✓ Press Enter to delete</Text>}
          {overlayError && <Text color="red">  {overlayError}</Text>}
          <Text dimColor>  Esc to cancel</Text>
        </Box>
      )}
    </Box>
  );
}
