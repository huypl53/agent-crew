import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import type { TraceNode } from '../types.ts';
import TraceDetailPanel from './TraceDetailPanel.tsx';

function node(overrides: Partial<TraceNode>): TraceNode {
  return {
    id: 'test-id',
    kind: 'root',
    label: 'test',
    status: null,
    timestamp: null,
    durationMs: null,
    children: [],
    meta: {},
    ...overrides,
  };
}

describe('TraceDetailPanel', () => {
  it('null node: renders prompt', () => {
    render(<TraceDetailPanel node={null} />);
    expect(screen.getByText('Select a node to inspect')).toBeInTheDocument();
  });

  it('root node: renders Crew title and counts from meta', () => {
    render(
      <TraceDetailPanel
        node={node({
          kind: 'root',
          meta: { agentCount: 3, taskCount: 7, messageCount: 42 },
        })}
      />,
    );
    expect(screen.getByText('Crew')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('room node: renders room name, members, topic', () => {
    render(
      <TraceDetailPanel
        node={node({
          kind: 'room',
          label: 'crew-agent',
          meta: {
            members: ['wk-01', 'wk-02'],
            topic: 'Sprint planning',
          } as any,
        })}
      />,
    );
    expect(screen.getByText('#crew-agent')).toBeInTheDocument();
    expect(screen.getByText('wk-01, wk-02')).toBeInTheDocument();
    expect(screen.getByText('Sprint planning')).toBeInTheDocument();
  });

  it('agent node: renders name, status pill, role', () => {
    render(
      <TraceDetailPanel
        node={node({
          kind: 'agent',
          label: 'wk-04',
          status: 'busy',
          meta: { role: 'worker', room_name: 'crew-agent' } as any,
        })}
      />,
    );
    expect(screen.getByText('wk-04')).toBeInTheDocument();
    expect(screen.getByText('busy')).toBeInTheDocument();
    expect(screen.getByText('worker')).toBeInTheDocument();
    expect(screen.getByText('crew-agent')).toBeInTheDocument();
  });

  it('task node: renders id, status, assigned_to, text', () => {
    render(
      <TraceDetailPanel
        node={node({
          kind: 'task',
          label: 'task-99',
          status: 'active',
          meta: {
            id: 99,
            assigned_to: 'wk-01',
            created_by: 'leader',
            room: 'crew-agent',
            text: 'Fix the parser bug',
          } as any,
        })}
      />,
    );
    expect(screen.getByText('Task #99')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('wk-01')).toBeInTheDocument();
    expect(screen.getByText('Fix the parser bug')).toBeInTheDocument();
  });

  it('message node: renders kind badge, from→to, text', () => {
    render(
      <TraceDetailPanel
        node={node({
          kind: 'message',
          label: 'msg-7',
          status: null,
          timestamp: 1700000000000,
          meta: {
            kind: 'task',
            from: 'leader',
            to: 'wk-04',
            text: 'Do the thing',
          } as any,
        })}
      />,
    );
    expect(screen.getByText('task')).toBeInTheDocument();
    expect(screen.getByText('leader → wk-04')).toBeInTheDocument();
    expect(screen.getByText('Do the thing')).toBeInTheDocument();
  });
});
