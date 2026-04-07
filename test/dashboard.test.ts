import { describe, expect, test } from 'bun:test';
import { buildTree, type TreeNode } from '../src/dashboard/hooks/useTree.ts';
import type { Agent, Room, Message } from '../src/shared/types.ts';

// Re-export the existing hook tests as the canonical dashboard tests
// (the detailed component tests live in test/dashboard-ink.test.tsx)

describe('dashboard tree (buildTree)', () => {
  function setup() {
    const agents: Record<string, Agent> = {
      boss: { agent_id: 'boss', name: 'boss', role: 'boss', rooms: ['company'], tmux_target: '%100', joined_at: '' },
      'lead-1': { agent_id: 'lead-1', name: 'lead-1', role: 'leader', rooms: ['company', 'frontend'], tmux_target: '%101', joined_at: '' },
      w1: { agent_id: 'w1', name: 'w1', role: 'worker', rooms: ['frontend'], tmux_target: '%102', joined_at: '' },
    };
    const rooms: Record<string, Room> = {
      company: { name: 'company', members: ['boss', 'lead-1'], created_at: '' },
      frontend: { name: 'frontend', members: ['lead-1', 'w1'], created_at: '' },
    };
    return { agents, rooms };
  }

  test('multi-room agents appear in each room', () => {
    const { agents, rooms } = setup();
    const nodes = buildTree(agents, rooms, new Set());
    expect(nodes.length).toBe(6);
  });

  test('secondary agent has room-scoped id', () => {
    const { agents, rooms } = setup();
    const nodes = buildTree(agents, rooms, new Set());
    const secondary = nodes.find(n => n.agentName === 'lead-1' && n.secondary);
    expect(secondary!.id).toBe('agent:lead-1:frontend');
  });

  test('room member count', () => {
    const { agents, rooms } = setup();
    const nodes = buildTree(agents, rooms, new Set());
    const fe = nodes.find(n => n.type === 'room' && n.label === 'frontend');
    expect(fe!.memberCount).toBe(2);
  });

  test('collapsed room hides members', () => {
    const { agents, rooms } = setup();
    const nodes = buildTree(agents, rooms, new Set(['company']));
    expect(nodes.find(n => n.agentName === 'boss')).toBeUndefined();
  });

  test('unassigned agents', () => {
    const agents: Record<string, Agent> = {
      ghost: { agent_id: 'ghost', name: 'ghost', role: 'worker', rooms: [], tmux_target: '%199', joined_at: '' },
    };
    const nodes = buildTree(agents, {}, new Set());
    expect(nodes.find(n => n.id === 'room:__unassigned__')).toBeDefined();
  });
});
