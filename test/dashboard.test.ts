import { describe, expect, test, beforeEach } from 'bun:test';
import { renderFrame } from '../src/dashboard/render.ts';
import { TreeState, type TreeNode } from '../src/dashboard/tree.ts';
import { MessageFeed } from '../src/dashboard/feed.ts';
import { matchStatusLine } from '../src/shared/status-patterns.ts';
import type { Agent, Room, Message } from '../src/shared/types.ts';
import type { AgentStatusEntry } from '../src/dashboard/status.ts';

// --- Render tests ---
describe('dashboard render', () => {
  const minSize = { cols: 80, rows: 24 };

  test('shows waiting when state unavailable', () => {
    const frame = renderFrame(minSize, [], -1, [], null, null, false);
    expect(frame).toContain('Waiting for cc-tmux...');
  });

  test('renders panel borders and titles', () => {
    const frame = renderFrame(minSize, [], 0, [], null, null, true);
    expect(frame).toContain('┌');
    expect(frame).toContain('Rooms & Agents');
    expect(frame).toContain('Messages');
    expect(frame).toContain('Details');
  });

  test('renders tree nodes', () => {
    const nodes: TreeNode[] = [
      { type: 'room', id: 'room:co', label: 'co', memberCount: 1 },
      { type: 'agent', id: 'agent:boss', label: 'boss', agentName: 'boss', role: 'boss', status: 'idle' },
    ];
    const frame = renderFrame(minSize, nodes, 1, [], null, null, true);
    expect(frame).toContain('co');
    expect(frame).toContain('boss');
  });

  test('renders agent details', () => {
    const agent: Agent = { agent_id: 'l1', name: 'lead-1', role: 'leader', rooms: ['co', 'fe'], tmux_target: '%101', joined_at: '2026-01-01' };
    const rooms: Record<string, Room> = {
      fe: { name: 'fe', members: ['lead-1'], created_at: '', topic: 'Build login flow' },
    };
    const frame = renderFrame(
      minSize,
      [],
      0,
      [],
      agent,
      { status: 'busy', lastChange: Date.now(), summary: 'Editing src/Login.tsx' },
      true,
      'fe',
      rooms,
    );
    expect(frame).toContain('lead-1');
    expect(frame).toContain('leader');
    expect(frame).toContain('co, fe');
    expect(frame).toContain('busy');
    expect(frame).toContain('Build login flow');
    expect(frame).toContain('Editing src/Login.tsx');
  });

  test('renders at minimum 80x24', () => {
    expect(renderFrame({ cols: 80, rows: 24 }, [], 0, [], null, null, true).length).toBeGreaterThan(0);
  });
});

// --- Tree tests ---
describe('dashboard tree', () => {
  function setup(): { agents: Record<string, Agent>; rooms: Record<string, Room>; statuses: Map<string, AgentStatusEntry> } {
    const agents: Record<string, Agent> = {
      boss: { agent_id: 'boss', name: 'boss', role: 'boss', rooms: ['company'], tmux_target: '%100', joined_at: '' },
      'lead-1': { agent_id: 'lead-1', name: 'lead-1', role: 'leader', rooms: ['company', 'frontend'], tmux_target: '%101', joined_at: '' },
      'w1': { agent_id: 'w1', name: 'w1', role: 'worker', rooms: ['frontend'], tmux_target: '%102', joined_at: '' },
    };
    const rooms: Record<string, Room> = {
      company: { name: 'company', members: ['boss', 'lead-1'], created_at: '' },
      frontend: { name: 'frontend', members: ['lead-1', 'w1'], created_at: '' },
    };
    const now = Date.now();
    const statuses = new Map<string, AgentStatusEntry>([
      ['boss', { status: 'idle', lastChange: now - 5000 }],
      ['lead-1', { status: 'busy', lastChange: now - 1000, summary: 'Working on auth flow' }],
      ['w1', { status: 'dead', lastChange: now }],
    ]);
    return { agents, rooms, statuses };
  }

  test('builds tree with rooms and agents', () => {
    const tree = new TreeState();
    const { agents, rooms, statuses } = setup();
    tree.build(agents, rooms, statuses);
    expect(tree.items.length).toBe(5); // 2 rooms + 3 agents (lead-1 primary=company)
    expect(tree.items[0]!.type).toBe('room');
    expect(tree.items[0]!.label).toBe('company');
  });

  test('no duplicate agents across rooms', () => {
    const tree = new TreeState();
    const { agents, rooms, statuses } = setup();
    tree.build(agents, rooms, statuses);
    const agentNames = tree.items.filter(n => n.type === 'agent').map(n => n.agentName);
    expect(new Set(agentNames).size).toBe(agentNames.length);
  });

  test('multi-room badge', () => {
    const tree = new TreeState();
    const { agents, rooms, statuses } = setup();
    tree.build(agents, rooms, statuses);
    const lead = tree.items.find(n => n.agentName === 'lead-1');
    expect(lead?.extraRooms).toEqual(['frontend']);
  });

  test('auto-selects most recently changed agent', () => {
    const tree = new TreeState();
    const { agents, rooms, statuses } = setup();
    tree.build(agents, rooms, statuses);
    expect(tree.selectedAgentName).toBe('w1'); // most recent lastChange
  });

  test('navigation moves selection', () => {
    const tree = new TreeState();
    const { agents, rooms, statuses } = setup();
    tree.build(agents, rooms, statuses);
    const initial = tree.selected;
    tree.moveUp();
    expect(tree.selected).toBeLessThanOrEqual(initial);
  });
});

// --- Feed tests ---
describe('dashboard feed', () => {
  function makeMsg(overrides: Partial<Message> = {}): Message {
    return {
      message_id: `msg-${Math.random().toString(36).slice(2)}`,
      from: 'lead-1', room: 'fe', to: 'w1', text: 'do stuff',
      timestamp: new Date().toISOString(), sequence: 1, mode: 'push',
      ...overrides,
    };
  }

  test('formats with timestamp', () => {
    const feed = new MessageFeed();
    feed.update([makeMsg({ timestamp: '2026-01-01T14:32:01.000Z' })]);
    expect(feed.messages[0]!.timestamp).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test('broadcast shows ALL', () => {
    const feed = new MessageFeed();
    feed.update([makeMsg({ to: null })]);
    expect(feed.messages[0]!.target).toBe('ALL');
  });

  test('deduplicates by id', () => {
    const feed = new MessageFeed();
    const msg = makeMsg({ message_id: 'dup' });
    feed.update([msg, msg]);
    expect(feed.messages.length).toBe(1);
  });

  test('caps at 500', () => {
    const feed = new MessageFeed();
    const msgs = Array.from({ length: 600 }, (_, i) =>
      makeMsg({ message_id: `m${i}`, timestamp: new Date(Date.now() + i * 1000).toISOString() })
    );
    feed.update(msgs);
    expect(feed.messages.length).toBe(500);
  });

  test('different colors per room', () => {
    const feed = new MessageFeed();
    feed.update([makeMsg({ message_id: 'a', room: 'r1' }), makeMsg({ message_id: 'b', room: 'r2' })]);
    expect(feed.messages[0]!.roomColor).not.toBe(feed.messages[1]!.roomColor);
  });
});
