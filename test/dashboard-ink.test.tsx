import React from 'react';
import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import { DetailsPanel } from '../src/dashboard/components/DetailsPanel.tsx';
import type { AgentStatusEntry } from '../src/dashboard/hooks/useStatus.ts';
import type { Agent, Room, Message, Task, TokenUsage } from '../src/shared/types.ts';

describe('DetailsPanel', () => {
  test('shows agent details with role and status', () => {
    const agent: Agent = { agent_id: 'l1', name: 'lead-1', role: 'leader', rooms: ['co'], tmux_target: '%101', joined_at: '2026-01-01' };
    const status: AgentStatusEntry = { status: 'busy', lastChange: Date.now(), rawOutput: 'Working...' };
    const { lastFrame } = render(
      <DetailsPanel agent={agent} agentStatus={status} selectedNode={{ type: 'agent', id: 'agent:lead-1', label: 'lead-1' }} rooms={{}} messages={[]} tasks={[]} tokenUsage={[]} isSyncing={false} height={10} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain('lead-1');
    expect(frame).toContain('busy');
    expect(frame).toContain('leader');
  });

  test('shows pane output', () => {
    const agent: Agent = { agent_id: 'l1', name: 'lead-1', role: 'leader', rooms: ['co'], tmux_target: '%101', joined_at: '2026-01-01' };
    const status: AgentStatusEntry = { status: 'busy', lastChange: Date.now(), rawOutput: 'Line 1\nLine 2\nLine 3' };
    const { lastFrame } = render(
      <DetailsPanel agent={agent} agentStatus={status} selectedNode={{ type: 'agent', id: 'agent:lead-1', label: 'lead-1' }} rooms={{}} messages={[]} tasks={[]} tokenUsage={[]} isSyncing={false} height={15} />
    );
    expect(lastFrame()!).toContain('pane');
  });

  test('shows task summary when room selected', () => {
    const now = new Date().toISOString();
    const tasks: Task[] = [
      { id: 1, room: 'fe', assigned_to: 'w1', created_by: 'boss', message_id: 1, summary: 'do auth', status: 'completed', created_at: now, updated_at: now },
      { id: 2, room: 'fe', assigned_to: 'w1', created_by: 'boss', message_id: 2, summary: 'do api', status: 'error', note: 'api failed', created_at: now, updated_at: now },
    ];
    const rooms: Record<string, Room> = { fe: { name: 'fe', members: ['boss', 'w1'], created_at: '', topic: 'Frontend' } };
    const { lastFrame } = render(
      <DetailsPanel agent={null} agentStatus={null} selectedNode={{ type: 'room', id: 'room:fe', label: 'fe', memberCount: 2 }} rooms={rooms} messages={[]} tasks={tasks} tokenUsage={[]} isSyncing={false} height={12} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain('─ Tasks ─');
    expect(frame).toContain('do auth');
    expect(frame).toContain('do api');
  });

  test('shows syncing state', () => {
    const { lastFrame } = render(
      <DetailsPanel agent={null} agentStatus={null} selectedNode={null} rooms={{}} messages={[]} tasks={[]} tokenUsage={[]} isSyncing={true} height={10} />
    );
    expect(lastFrame()!).toContain('Syncing');
  });
});
