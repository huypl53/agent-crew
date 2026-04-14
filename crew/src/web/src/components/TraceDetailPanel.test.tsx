import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TraceDetailPanel from './TraceDetailPanel.tsx';
import type { TraceNode } from '../types.ts';

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

  it('root node: renders Overview tab with Crew counts from meta', () => {
    render(
      <TraceDetailPanel node={node({
        kind: 'root',
        meta: { agentCount: 3, taskCount: 7, messageCount: 42 },
      })} />
    );
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('room node: renders Members tab with room info', () => {
    render(
      <TraceDetailPanel node={node({
        kind: 'room',
        label: 'crew-agent',
        meta: { members: ['wk-01', 'wk-02'], topic: 'Sprint planning' } as any,
      })} />
    );
    expect(screen.getByText('Members')).toBeInTheDocument();
    expect(screen.getByText('Sprint planning')).toBeInTheDocument();
    expect(screen.getByText('wk-01, wk-02')).toBeInTheDocument();
  });

  it('agent node: renders Stats tab with status, role, rooms', () => {
    render(
      <TraceDetailPanel node={node({
        kind: 'agent',
        label: 'wk-04',
        status: 'busy',
        meta: { role: 'worker', rooms: ['crew-agent'] } as any,
      })} />
    );
    expect(screen.getByText('Stats')).toBeInTheDocument();
    expect(screen.getByText('wk-04')).toBeInTheDocument();
    expect(screen.getByText('busy')).toBeInTheDocument();
    expect(screen.getByText('worker')).toBeInTheDocument();
    expect(screen.getByText('crew-agent')).toBeInTheDocument();
  });

  it('task node: renders Instructions tab with id, status, assigned_to, text', () => {
    render(
      <TraceDetailPanel node={node({
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
      })} />
    );
    expect(screen.getByText('Instructions')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('wk-01')).toBeInTheDocument();
    expect(screen.getByText('Fix the parser bug')).toBeInTheDocument();
  });

  it('message node: renders Input tab with kind badge, from, timestamp', () => {
    render(
      <TraceDetailPanel node={node({
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
      })} />
    );
    expect(screen.getByText('Input')).toBeInTheDocument();
    expect(screen.getByText('task')).toBeInTheDocument();
    expect(screen.getByText('leader')).toBeInTheDocument();
  });

  it('breadcrumb renders when ancestors provided', () => {
    const root = node({ kind: 'root', label: 'Home' });
    const room = node({ kind: 'room', label: 'crew-agent' });
    render(
      <TraceDetailPanel
        node={room}
        ancestors={[root, room]}
        onAncestorSelect={() => {}}
      />
    );
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('crew-agent')).toBeInTheDocument();
  });

  it('cost tab renders token_usage when present', () => {
    render(
      <TraceDetailPanel node={node({
        kind: 'agent',
        label: 'wk-01',
        meta: {
          token_usage: {
            model: 'claude-sonnet-4-6',
            input_tokens: 12345,
            output_tokens: 6789,
            cost_usd: 0.1234,
          },
        } as any,
      })}
      />
    );
    expect(screen.getByText('Stats')).toBeInTheDocument();
    // Click Cost tab
    const costTab = screen.getByText('Cost');
    costTab.click();
    expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument();
    expect(screen.getByText('12,345')).toBeInTheDocument();
    expect(screen.getByText('6,789')).toBeInTheDocument();
  });
});
