import { describe, expect, test } from 'bun:test';
import type { Agent, Room } from '../src/shared/types.ts';
import { buildTree } from '../src/dashboard/hooks/useTree.ts';

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

describe('buildTree', () => {
  test('builds nodes with rooms and agents — multi-room agents appear in each room', () => {
    const { agents, rooms } = setup();
    const nodes = buildTree(agents, rooms, new Set());
    expect(nodes.length).toBe(6);
    expect(nodes[0]!.type).toBe('room');
    expect(nodes[0]!.label).toBe('company');
  });

  test('secondary agent has room-scoped id', () => {
    const { agents, rooms } = setup();
    const nodes = buildTree(agents, rooms, new Set());
    const secondary = nodes.find(n => n.agentName === 'lead-1' && n.secondary);
    expect(secondary).toBeDefined();
    expect(secondary!.id).toBe('agent:lead-1:frontend');
  });

  test('collapsed rooms hide members', () => {
    const { agents, rooms } = setup();
    const nodes = buildTree(agents, rooms, new Set(['company']));
    const companyRoom = nodes.find(n => n.label === 'company');
    expect(companyRoom!.collapsed).toBe(true);
    expect(nodes.find(n => n.agentName === 'boss')).toBeUndefined();
  });

  test('unassigned agents get their own section', () => {
    const agents: Record<string, Agent> = {
      ghost: { agent_id: 'ghost', name: 'ghost', role: 'worker', rooms: [], tmux_target: '%199', joined_at: '' },
    };
    const nodes = buildTree(agents, {}, new Set());
    expect(nodes.find(n => n.id === 'room:__unassigned__')).toBeDefined();
    expect(nodes.find(n => n.agentName === 'ghost')).toBeDefined();
  });

  test('agents include role field', () => {
    const { agents, rooms } = setup();
    const nodes = buildTree(agents, rooms, new Set());
    const boss = nodes.find(n => n.agentName === 'boss');
    expect(boss!.role).toBe('boss');
    const leader = nodes.find(n => n.agentName === 'lead-1' && !n.secondary);
    expect(leader!.role).toBe('leader');
  });
});
