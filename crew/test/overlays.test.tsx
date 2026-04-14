import React from 'react';
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { render } from 'ink-testing-library';
import { dbCreateRoom, dbSetTopic, dbDeleteRoom, dbUpdateAgentPersona, dbUpdateAgentCapabilities, dbRemoveAgentFromRoom, dbDeleteAgent } from '../src/state/db-write.ts';
import { initDb, closeDb } from '../src/state/db.ts';
import { addAgent } from '../src/state/index.ts';
import { rmSync, mkdirSync } from 'fs';
import { RoomOverlay, computeDeleteWarnings } from '../src/dashboard/components/RoomOverlay.tsx';
import { AgentOverlay, parseCapabilities, capabilitiesToInput } from '../src/dashboard/components/AgentOverlay.tsx';
import type { Room, Message, Agent } from '../src/shared/types.ts';
import type { AgentStatusEntry } from '../src/dashboard/hooks/useStatus.ts';

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('parseCapabilities', () => {
  test('splits comma-separated string', () => {
    expect(parseCapabilities('coding, testing, review')).toEqual(['coding', 'testing', 'review']);
  });
  test('filters empty entries', () => {
    expect(parseCapabilities(' ,, foo , ')).toEqual(['foo']);
  });
  test('returns empty array for empty string', () => {
    expect(parseCapabilities('')).toEqual([]);
  });
});

describe('capabilitiesToInput', () => {
  test('parses JSON array to comma-separated string', () => {
    expect(capabilitiesToInput('["coding","testing"]')).toBe('coding, testing');
  });
  test('returns empty string for undefined', () => {
    expect(capabilitiesToInput(undefined)).toBe('');
  });
  test('returns raw string if not valid JSON', () => {
    expect(capabilitiesToInput('coding,testing')).toBe('coding,testing');
  });
});

describe('computeDeleteWarnings', () => {
  const statuses: Map<string, AgentStatusEntry> = new Map([
    ['agent-a', { status: 'busy', lastChange: Date.now() }],
    ['agent-b', { status: 'idle', lastChange: Date.now() }],
  ]);
  const room: Room = { name: 'test-room', members: ['agent-a', 'agent-b'], created_at: '2026-01-01' };
  const messages: Message[] = [
    { message_id: '1', from: 'agent-a', room: 'test-room', to: null, text: 'hi', kind: 'chat', timestamp: '2026-01-01', sequence: 1, mode: 'push' },
    { message_id: '2', from: 'agent-b', room: 'other-room', to: null, text: 'hi', kind: 'chat', timestamp: '2026-01-01', sequence: 2, mode: 'push' },
  ];

  test('counts members and busy agents correctly', () => {
    const w = computeDeleteWarnings(room, messages, statuses);
    expect(w.memberCount).toBe(2);
    expect(w.busyAgents).toEqual(['agent-a']);
    expect(w.messageCount).toBe(1);
  });
});

// ── RoomOverlay rendering ─────────────────────────────────────────────────────

describe('RoomOverlay', () => {
  const emptyStatuses = new Map<string, AgentStatusEntry>();
  const room: Room = { name: 'my-room', members: ['alice'], created_at: '2026-01-01' };

  test('menu mode shows room name and options', () => {
    const { lastFrame } = render(
      <RoomOverlay mode="menu" selectedRoom={room} rooms={{}} messages={[]} statuses={emptyStatuses}
        inputValue="" createStep="name" createName="" createError="" height={10} />
    );
    expect(lastFrame()).toContain('my-room');
    expect(lastFrame()).toContain('Set topic');
    expect(lastFrame()).toContain('Delete room');
  });

  test('create mode shows name input', () => {
    const { lastFrame } = render(
      <RoomOverlay mode="create" selectedRoom={null} rooms={{}} messages={[]} statuses={emptyStatuses}
        inputValue="new-r" createStep="name" createName="" createError="" height={10} />
    );
    expect(lastFrame()).toContain('Create room');
    expect(lastFrame()).toContain('new-r');
  });

  test('create mode shows error', () => {
    const { lastFrame } = render(
      <RoomOverlay mode="create" selectedRoom={null} rooms={{}} messages={[]} statuses={emptyStatuses}
        inputValue="" createStep="name" createName="" createError="Name required" height={10} />
    );
    expect(lastFrame()).toContain('Name required');
  });

  test('create topic step shows name as dimmed and topic input', () => {
    const { lastFrame } = render(
      <RoomOverlay mode="create" selectedRoom={null} rooms={{}} messages={[]} statuses={emptyStatuses}
        inputValue="my-topic" createStep="topic" createName="my-room" createError="" height={10} />
    );
    expect(lastFrame()).toContain('my-room');
    expect(lastFrame()).toContain('my-topic');
  });

  test('set-topic mode shows current room and input', () => {
    const { lastFrame } = render(
      <RoomOverlay mode="set-topic" selectedRoom={room} rooms={{}} messages={[]} statuses={emptyStatuses}
        inputValue="new topic" createStep="name" createName="" createError="" height={10} />
    );
    expect(lastFrame()).toContain('Set topic: my-room');
    expect(lastFrame()).toContain('new topic');
  });

  test('confirm-delete shows warning for busy agent', () => {
    const busyStatuses = new Map<string, AgentStatusEntry>([['alice', { status: 'busy', lastChange: Date.now() }]]);
    const { lastFrame } = render(
      <RoomOverlay mode="confirm-delete" selectedRoom={room} rooms={{}} messages={[]} statuses={busyStatuses}
        inputValue="" createStep="name" createName="" createError="" height={15} />
    );
    expect(lastFrame()).toContain('BUSY');
  });

  test('confirm-delete shows green checkmark when name matches', () => {
    const { lastFrame } = render(
      <RoomOverlay mode="confirm-delete" selectedRoom={room} rooms={{}} messages={[]} statuses={emptyStatuses}
        inputValue="my-room" createStep="name" createName="" createError="" height={12} />
    );
    expect(lastFrame()).toContain('✓');
  });
});

// ── AgentOverlay rendering ────────────────────────────────────────────────────

describe('AgentOverlay', () => {
  const emptyStatuses = new Map<string, AgentStatusEntry>();
  const agent: Agent = { agent_id: 'a1', name: 'bob', role: 'worker', rooms: ['room-a'], tmux_target: '%5', agent_type: 'claude-code', joined_at: '2026-01-01' };

  test('returns null when agent is null', () => {
    const { lastFrame } = render(
      <AgentOverlay mode="menu" agent={null} selectedRoomName="room-a" statuses={emptyStatuses}
        inputValue="" overlayError="" height={10} />
    );
    expect(lastFrame()).toBe('');
  });

  test('menu mode shows agent name and options', () => {
    const { lastFrame } = render(
      <AgentOverlay mode="menu" agent={agent} selectedRoomName="room-a" statuses={emptyStatuses}
        inputValue="" overlayError="" height={10} />
    );
    expect(lastFrame()).toContain('bob');
    expect(lastFrame()).toContain('Edit persona');
    expect(lastFrame()).toContain('Edit capabilities');
    expect(lastFrame()).toContain('Remove from room');
    expect(lastFrame()).toContain('Delete agent');
  });

  test('edit-persona mode shows agent name and input', () => {
    const { lastFrame } = render(
      <AgentOverlay mode="edit-persona" agent={agent} selectedRoomName="room-a" statuses={emptyStatuses}
        inputValue="senior engineer" overlayError="" height={10} />
    );
    expect(lastFrame()).toContain('Persona: bob');
    expect(lastFrame()).toContain('senior engineer');
  });

  test('edit-capabilities mode shows comma-separated hint', () => {
    const { lastFrame } = render(
      <AgentOverlay mode="edit-capabilities" agent={agent} selectedRoomName="room-a" statuses={emptyStatuses}
        inputValue="coding, review" overlayError="" height={10} />
    );
    expect(lastFrame()).toContain('comma-separated');
    expect(lastFrame()).toContain('coding, review');
  });

  test('confirm-remove warns when agent is busy', () => {
    const busyStatuses = new Map<string, AgentStatusEntry>([['bob', { status: 'busy', lastChange: Date.now() }]]);
    const { lastFrame } = render(
      <AgentOverlay mode="confirm-remove" agent={agent} selectedRoomName="room-a" statuses={busyStatuses}
        inputValue="" overlayError="" height={12} />
    );
    expect(lastFrame()).toContain('BUSY');
  });

  test('confirm-delete shows room membership warning', () => {
    const { lastFrame } = render(
      <AgentOverlay mode="confirm-delete" agent={agent} selectedRoomName="room-a" statuses={emptyStatuses}
        inputValue="" overlayError="" height={14} />
    );
    expect(lastFrame()).toContain('Member of 1 room');
    expect(lastFrame()).toContain('room-a');
  });

  test('confirm-delete shows green checkmark when name matches', () => {
    const { lastFrame } = render(
      <AgentOverlay mode="confirm-delete" agent={agent} selectedRoomName="room-a" statuses={emptyStatuses}
        inputValue="bob" overlayError="" height={14} />
    );
    expect(lastFrame()).toContain('✓');
  });

  test('shows error when overlayError set', () => {
    const { lastFrame } = render(
      <AgentOverlay mode="edit-persona" agent={agent} selectedRoomName="room-a" statuses={emptyStatuses}
        inputValue="" overlayError="Save failed" height={10} />
    );
    expect(lastFrame()).toContain('Save failed');
  });
});

// ── db-write round-trip ───────────────────────────────────────────────────────
// db-write opens its own file connection via CREW_STATE_DIR. We point both the
// state module (initDb) and db-write at the same temp directory so they share
// the same file.

const TEST_STATE_DIR = '/tmp/crew-overlay-test-' + process.pid;

describe('db-write round-trip', () => {
  beforeEach(() => {
    mkdirSync(TEST_STATE_DIR, { recursive: true });
    process.env.CREW_STATE_DIR = TEST_STATE_DIR;
    initDb(); // creates file at TEST_STATE_DIR/crew.db
  });

  afterEach(() => {
    closeDb();
    delete process.env.CREW_STATE_DIR;
    rmSync(TEST_STATE_DIR, { recursive: true, force: true });
  });

  test('dbCreateRoom creates room; dbSetTopic updates it', () => {
    const create = dbCreateRoom('overlay-room', 'initial topic');
    expect(create.error).toBeUndefined();
    const topic = dbSetTopic('overlay-room', 'updated topic');
    expect(topic.error).toBeUndefined();
  });

  test('dbCreateRoom returns error for duplicate room', () => {
    dbCreateRoom('dup-room');
    const second = dbCreateRoom('dup-room');
    expect(second.error).toBeDefined();
  });

  test('dbDeleteRoom removes room and its messages', () => {
    dbCreateRoom('room-to-delete');
    const result = dbDeleteRoom('room-to-delete');
    expect(result.error).toBeUndefined();
  });

  test('dbUpdateAgentPersona updates agent persona', () => {
    addAgent('persona-agent', 'worker', 'overlay-room', '%1');
    const result = dbUpdateAgentPersona('persona-agent', 'senior engineer');
    expect(result.error).toBeUndefined();
  });

  test('dbUpdateAgentCapabilities stores JSON capabilities', () => {
    addAgent('cap-agent', 'worker', 'overlay-room', '%2');
    const result = dbUpdateAgentCapabilities('cap-agent', ['coding', 'review']);
    expect(result.error).toBeUndefined();
  });

  test('dbRemoveAgentFromRoom removes member; deletes agent if last room', () => {
    addAgent('solo-agent', 'worker', 'overlay-room', '%3');
    const result = dbRemoveAgentFromRoom('solo-agent', 'overlay-room');
    expect(result.error).toBeUndefined();
  });

  test('dbDeleteAgent removes agent from all rooms', () => {
    addAgent('del-agent', 'worker', 'overlay-room', '%4');
    const result = dbDeleteAgent('del-agent');
    expect(result.error).toBeUndefined();
    expect(result.removed_from_rooms).toContain('overlay-room');
  });
});
