# Dashboard Ink Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite `src/dashboard/` from raw ANSI rendering to React+Ink components, adding role-in-tree and task-summary features.

**Architecture:** React component tree (`App > Layout > TreePanel + MessageFeed + DetailsPanel + StatusBar + HelpOverlay`) rendered via Ink. Business logic lives in custom hooks (`useTree`, `useFeed`, `useStatus`, `useStateReader`). Components are pure renderers.

**Tech Stack:** Ink 6.8.0, React 19, Bun 1.3.8. TSX with `"jsx": "react-jsx"` (already configured in tsconfig.json).

---

### Task 1: Install Ink Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install packages**

Run:
```bash
bun add ink react @inkjs/ui
bun add -d ink-testing-library react-devtools-core @types/react
```

**Step 2: Verify Ink loads with Bun**

Run:
```bash
bun -e "const { Box, Text } = require('ink'); console.log('ink ok:', typeof Box)"
```

Expected: `ink ok: object` (or `function`)

**Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore: add ink, react, @inkjs/ui dependencies for dashboard migration"
```

---

### Task 2: Create Hooks from Existing Classes

Convert the 4 class-based modules into React hooks. The hook logic is identical to the class logic — this is a mechanical refactor, not a rewrite.

**Files:**
- Create: `src/dashboard/hooks/useTree.ts`
- Create: `src/dashboard/hooks/useStateReader.ts`
- Create: `src/dashboard/hooks/useFeed.ts`
- Create: `src/dashboard/hooks/useStatus.ts`
- Test: `test/dashboard-hooks.test.ts`

**Step 1: Write the test for useTree**

```ts
// test/dashboard-hooks.test.ts
import { describe, expect, test } from 'bun:test';
import type { Agent, Room } from '../src/shared/types.ts';
import type { AgentStatusEntry } from '../src/dashboard/status.ts';

// --- Pure functions extracted from tree logic ---
import { buildTree, type TreeNode } from '../src/dashboard/hooks/useTree.ts';

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
  const statuses = new Map<string, AgentStatusEntry>([
    ['boss', { status: 'idle', lastChange: Date.now() - 5000 }],
    ['lead-1', { status: 'busy', lastChange: Date.now() - 1000 }],
    ['w1', { status: 'dead', lastChange: Date.now() }],
  ]);
  return { agents, rooms, statuses };
}

describe('buildTree', () => {
  test('builds nodes with rooms and agents — multi-room agents appear in each room', () => {
    const { agents, rooms, statuses } = setup();
    const nodes = buildTree(agents, rooms, statuses, new Set());
    expect(nodes.length).toBe(6);
    expect(nodes[0]!.type).toBe('room');
    expect(nodes[0]!.label).toBe('company');
  });

  test('secondary agent has room-scoped id', () => {
    const { agents, rooms, statuses } = setup();
    const nodes = buildTree(agents, rooms, statuses, new Set());
    const secondary = nodes.find(n => n.agentName === 'lead-1' && n.secondary);
    expect(secondary).toBeDefined();
    expect(secondary!.id).toBe('agent:lead-1:frontend');
  });

  test('collapsed rooms hide members', () => {
    const { agents, rooms, statuses } = setup();
    const collapsed = new Set(['company']);
    const nodes = buildTree(agents, rooms, statuses, collapsed);
    const companyRoom = nodes.find(n => n.label === 'company');
    expect(companyRoom!.collapsed).toBe(true);
    const bossInCompany = nodes.find(n => n.agentName === 'boss');
    expect(bossInCompany).toBeUndefined(); // hidden because company is collapsed
  });

  test('unassigned agents get their own section', () => {
    const agents: Record<string, Agent> = {
      ghost: { agent_id: 'ghost', name: 'ghost', role: 'worker', rooms: [], tmux_target: '%199', joined_at: '' },
    };
    const nodes = buildTree(agents, {}, new Map(), new Set());
    expect(nodes.find(n => n.id === 'room:__unassigned__')).toBeDefined();
    expect(nodes.find(n => n.agentName === 'ghost')).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/dashboard-hooks.test.ts`
Expected: FAIL — cannot resolve `../src/dashboard/hooks/useTree.ts`

**Step 3: Implement useTree hook**

Create `src/dashboard/hooks/useTree.ts`. Extract the pure `buildTree` function from the `TreeState` class, then wrap it in a React hook:

```ts
import { useState, useCallback, useMemo } from 'react';
import type { Agent, Room, AgentStatus } from '../../shared/types.ts';
import type { AgentStatusEntry } from '../status.ts';

export interface TreeNode {
  type: 'room' | 'agent';
  id: string;
  label: string;
  memberCount?: number;
  collapsed?: boolean;
  agentName?: string;
  role?: string;
  status?: AgentStatus;
  secondary?: boolean;
}

/** Pure function: builds the flat node list from agents/rooms/statuses. Exported for testing. */
export function buildTree(
  agents: Record<string, Agent>,
  rooms: Record<string, Room>,
  statuses: Map<string, AgentStatusEntry>,
  collapsedRooms: Set<string>,
): TreeNode[] {
  const nodes: TreeNode[] = [];

  for (const roomName of Object.keys(rooms).sort()) {
    const room = rooms[roomName]!;
    nodes.push({
      type: 'room', id: `room:${roomName}`, label: roomName,
      memberCount: room.members.length,
      collapsed: collapsedRooms.has(roomName),
    });
    if (!collapsedRooms.has(roomName)) {
      for (const memberName of room.members) {
        const agent = agents[memberName];
        if (!agent) continue;
        const isPrimary = agent.rooms[0] === roomName;
        const nodeId = isPrimary ? `agent:${memberName}` : `agent:${memberName}:${roomName}`;
        nodes.push({
          type: 'agent', id: nodeId, label: memberName,
          agentName: memberName, role: agent.role,
          status: statuses.get(memberName)?.status ?? 'unknown',
          secondary: !isPrimary,
        });
      }
    }
  }

  // Unassigned: agents with no rooms
  const unassigned = Object.values(agents).filter(a => !a.rooms || a.rooms.length === 0);
  if (unassigned.length > 0) {
    nodes.push({
      type: 'room', id: 'room:__unassigned__',
      label: '── Unassigned ──',
      memberCount: unassigned.length,
      collapsed: collapsedRooms.has('__unassigned__'),
    });
    if (!collapsedRooms.has('__unassigned__')) {
      for (const agent of unassigned) {
        nodes.push({
          type: 'agent', id: `agent:${agent.name}`,
          label: agent.name, agentName: agent.name,
          role: agent.role, status: statuses.get(agent.name)?.status ?? 'unknown',
        });
      }
    }
  }
  return nodes;
}

export interface UseTreeReturn {
  nodes: TreeNode[];
  selectedIndex: number;
  selectedNode: TreeNode | null;
  selectedAgentName: string | null;
  selectedRoomName: string | null;
  moveUp: () => void;
  moveDown: () => void;
  moveToTop: () => void;
  moveToBottom: () => void;
  toggleCollapse: () => void;
}

export function useTree(
  agents: Record<string, Agent>,
  rooms: Record<string, Room>,
  statuses: Map<string, AgentStatusEntry>,
): UseTreeReturn {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedRooms, setCollapsedRooms] = useState<Set<string>>(new Set());
  const [autoSelect, setAutoSelect] = useState(true);
  const [lastMostRecentAgent, setLastMostRecentAgent] = useState<string | null>(null);

  const nodes = useMemo(() => buildTree(agents, rooms, statuses, collapsedRooms), [agents, rooms, statuses, collapsedRooms]);

  // Find most recently changed agent
  let mostRecent: string | null = null;
  let mostRecentTime = 0;
  for (const [name, entry] of statuses.entries()) {
    if (entry.lastChange > mostRecentTime) { mostRecentTime = entry.lastChange; mostRecent = name; }
  }

  // Resolve selected index from selectedId
  let selectedIndex = -1;

  // Auto-select most recently active agent
  if (autoSelect && mostRecent && mostRecent !== lastMostRecentAgent) {
    setLastMostRecentAgent(mostRecent);
    const idx = nodes.findIndex(n => n.type === 'agent' && n.agentName === mostRecent);
    if (idx >= 0) {
      selectedIndex = idx;
      setSelectedId(nodes[idx]!.id);
    }
  }

  // Restore by ID
  if (selectedId) {
    const idx = nodes.findIndex(n => n.id === selectedId);
    if (idx >= 0) selectedIndex = idx;
  }

  // Fallback
  if (selectedIndex < 0 && nodes.length > 0) {
    const first = nodes.findIndex(n => n.type === 'agent');
    selectedIndex = first >= 0 ? first : 0;
    if (!selectedId) setSelectedId(nodes[selectedIndex]?.id ?? null);
  }
  if (selectedIndex >= nodes.length) selectedIndex = Math.max(0, nodes.length - 1);

  const selectedNode = nodes[selectedIndex] ?? null;

  const selectedAgentName = selectedNode?.type === 'agent' ? (selectedNode.agentName ?? null) : null;

  let selectedRoomName: string | null = null;
  if (selectedNode?.type === 'room') {
    selectedRoomName = selectedNode.label;
  } else if (selectedNode?.type === 'agent') {
    for (let i = selectedIndex - 1; i >= 0; i--) {
      if (nodes[i]?.type === 'room') { selectedRoomName = nodes[i]!.label; break; }
    }
  }

  const moveUp = useCallback(() => {
    setAutoSelect(false);
    setSelectedId(prev => {
      const idx = nodes.findIndex(n => n.id === prev);
      if (idx > 0) return nodes[idx - 1]!.id;
      return prev;
    });
  }, [nodes]);

  const moveDown = useCallback(() => {
    setAutoSelect(false);
    setSelectedId(prev => {
      const idx = nodes.findIndex(n => n.id === prev);
      if (idx < nodes.length - 1) return nodes[idx + 1]!.id;
      return prev;
    });
  }, [nodes]);

  const moveToTop = useCallback(() => {
    setAutoSelect(false);
    if (nodes.length > 0) setSelectedId(nodes[0]!.id);
  }, [nodes]);

  const moveToBottom = useCallback(() => {
    setAutoSelect(false);
    if (nodes.length > 0) setSelectedId(nodes[nodes.length - 1]!.id);
  }, [nodes]);

  const toggleCollapse = useCallback(() => {
    if (!selectedNode || selectedNode.type !== 'room') return;
    const roomId = selectedNode.id === 'room:__unassigned__' ? '__unassigned__' : selectedNode.label;
    setCollapsedRooms(prev => {
      const next = new Set(prev);
      if (next.has(roomId)) next.delete(roomId); else next.add(roomId);
      return next;
    });
  }, [selectedNode]);

  return { nodes, selectedIndex, selectedNode, selectedAgentName, selectedRoomName, moveUp, moveDown, moveToTop, moveToBottom, toggleCollapse };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/dashboard-hooks.test.ts`
Expected: PASS (4 tests)

**Step 5: Create remaining hooks (useFeed, useStatus, useStateReader)**

Create `src/dashboard/hooks/useFeed.ts`:

```ts
import { useState, useCallback, useRef } from 'react';
import type { Message } from '../../shared/types.ts';

const MAX_MESSAGES = 500;
const ROOM_COLORS = ['cyan', 'magenta', 'blue', 'green', 'yellow'] as const;

export interface FormattedMessage {
  id: string;
  timestamp: string;
  sender: string;
  room: string;
  target: string;
  text: string;
  kind: string;
  roomColor: typeof ROOM_COLORS[number];
}

export function useFeed() {
  const [messages, setMessages] = useState<FormattedMessage[]>([]);
  const seenIds = useRef(new Set<string>());
  const roomColorMap = useRef(new Map<string, typeof ROOM_COLORS[number]>());

  const getRoomColor = (room: string): typeof ROOM_COLORS[number] => {
    let c = roomColorMap.current.get(room);
    if (!c) { c = ROOM_COLORS[roomColorMap.current.size % ROOM_COLORS.length]!; roomColorMap.current.set(room, c); }
    return c;
  };

  const update = useCallback((rawMessages: Message[]) => {
    const sorted = [...rawMessages].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    let added = false;
    const newItems: FormattedMessage[] = [];
    for (const msg of sorted) {
      if (seenIds.current.has(msg.message_id)) continue;
      seenIds.current.add(msg.message_id);
      added = true;
      const d = new Date(msg.timestamp);
      const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      newItems.push({
        id: msg.message_id, timestamp: ts, sender: msg.from, room: msg.room,
        target: msg.to ?? 'ALL', text: msg.text, kind: msg.kind ?? 'chat',
        roomColor: getRoomColor(msg.room),
      });
    }
    if (added) {
      setMessages(prev => {
        const combined = [...prev, ...newItems];
        return combined.length > MAX_MESSAGES ? combined.slice(-MAX_MESSAGES) : combined;
      });
    }
  }, []);

  return { messages, update };
}
```

Create `src/dashboard/hooks/useStatus.ts`:

```ts
import { useState, useCallback, useRef } from 'react';
import { capturePane, isPaneDead } from '../../tmux/index.ts';
import { matchStatusLine } from '../../shared/status-patterns.ts';
import type { Agent, AgentStatus } from '../../shared/types.ts';
import { logError } from '../logger.ts';

export interface AgentStatusEntry {
  status: AgentStatus;
  lastChange: number;
  rawOutput?: string;
}

export function useStatus() {
  const [statuses, setStatuses] = useState<Map<string, AgentStatusEntry>>(new Map());
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;

  const pollAll = useCallback(async (agents: Record<string, Agent>) => {
    const next = new Map<string, AgentStatusEntry>();
    for (const [name, agent] of Object.entries(agents)) {
      const prev = statusesRef.current.get(name);
      try {
        if (await isPaneDead(agent.tmux_target)) {
          next.set(name, { status: 'dead', lastChange: prev?.status !== 'dead' ? Date.now() : (prev?.lastChange ?? Date.now()) });
          continue;
        }
        const output = await capturePane(agent.tmux_target);
        if (output === null) {
          next.set(name, { status: 'unknown', lastChange: prev?.lastChange ?? Date.now() });
          continue;
        }
        const status = matchStatusLine(output);
        const changed = !prev || prev.status !== status;
        next.set(name, { status, lastChange: changed ? Date.now() : prev!.lastChange, rawOutput: output });
      } catch (e) {
        logError('status.pollOne', e);
        next.set(name, { status: 'unknown', lastChange: prev?.lastChange ?? Date.now() });
      }
    }
    setStatuses(next);
  }, []);

  const getStatus = useCallback((name: string): AgentStatusEntry => {
    return statusesRef.current.get(name) ?? { status: 'unknown', lastChange: Date.now() };
  }, []);

  return { statuses, pollAll, getStatus };
}
```

Create `src/dashboard/hooks/useStateReader.ts`:

```ts
import { useState, useEffect, useRef } from 'react';
import { Database } from 'bun:sqlite';
import type { Agent, Room, Message } from '../../shared/types.ts';
import { logError } from '../logger.ts';

const STATE_DIR = process.env.CC_TMUX_STATE_DIR ?? '/tmp/cc-tmux/state';
const DB_PATH = `${STATE_DIR}/cc-tmux.db`;
const POLL_INTERVAL = 500;

export interface DashboardState {
  agents: Record<string, Agent>;
  rooms: Record<string, Room>;
  messages: Message[];
}

const EMPTY_STATE: DashboardState = { agents: {}, rooms: {}, messages: [] };

export function useStateReader() {
  const [state, setState] = useState<DashboardState>(EMPTY_STATE);
  const [isAvailable, setIsAvailable] = useState(false);
  const lastDataVersion = useRef(0);

  useEffect(() => {
    function readAll(): DashboardState | null {
      let db: Database | null = null;
      try {
        if (!require('fs').existsSync(DB_PATH)) return null;
        db = new Database(DB_PATH, { readonly: true });

        const agentRows = db.query<{ name: string; role: Agent['role']; pane: string; registered_at: string; last_activity: string | null }, []>(
          'SELECT name, role, pane, registered_at, last_activity FROM agents'
        ).all();
        const roomRows = db.query<{ name: string; topic: string | null; created_at: string }, []>(
          'SELECT name, topic, created_at FROM rooms'
        ).all();
        const memberRows = db.query<{ room: string; agent: string; joined_at: string }, []>(
          'SELECT room, agent, joined_at FROM members'
        ).all();
        const messageRows = db.query<{ id: number; sender: string; room: string; recipient: string | null; text: string; kind: Message['kind']; mode: Message['mode']; timestamp: string }, []>(
          'SELECT id, sender, room, recipient, text, kind, mode, timestamp FROM messages ORDER BY id ASC'
        ).all();

        const rooms: Record<string, Room> = {};
        for (const row of roomRows) {
          rooms[row.name] = { name: row.name, topic: row.topic ?? undefined, members: [], created_at: row.created_at };
        }
        const agentRooms = new Map<string, string[]>();
        for (const row of memberRows) {
          if (!rooms[row.room]) rooms[row.room] = { name: row.room, members: [], created_at: row.joined_at };
          rooms[row.room]!.members.push(row.agent);
          const existing = agentRooms.get(row.agent) ?? [];
          existing.push(row.room);
          agentRooms.set(row.agent, existing);
        }
        const agents: Record<string, Agent> = {};
        for (const row of agentRows) {
          agents[row.name] = {
            agent_id: row.name, name: row.name, role: row.role,
            rooms: agentRooms.get(row.name) ?? [],
            tmux_target: row.pane, joined_at: row.registered_at,
            last_activity: row.last_activity ?? undefined,
          };
        }
        const messages: Message[] = messageRows.map(row => ({
          message_id: String(row.id), from: row.sender, room: row.room,
          to: row.recipient, text: row.text, kind: row.kind,
          timestamp: row.timestamp, sequence: row.id, mode: row.mode,
        }));
        return { agents, rooms, messages };
      } catch (e) {
        logError('state-reader.readAll', e);
        return null;
      } finally {
        db?.close(false);
      }
    }

    // Initial read
    const initial = readAll();
    if (initial) { setState(initial); setIsAvailable(true); }

    // Poll for changes
    const timer = setInterval(() => {
      let db: Database | null = null;
      try {
        if (!require('fs').existsSync(DB_PATH)) {
          if (isAvailable) { setState(EMPTY_STATE); setIsAvailable(false); lastDataVersion.current = 0; }
          return;
        }
        db = new Database(DB_PATH, { readonly: true });
        const row = db.query<{ data_version: number }, []>('PRAGMA data_version').get();
        const version = row?.data_version ?? 0;
        if (version !== lastDataVersion.current || !isAvailable) {
          lastDataVersion.current = version;
          db.close(false);
          db = null;
          const next = readAll();
          if (next) { setState(next); setIsAvailable(true); }
          else { setState(EMPTY_STATE); setIsAvailable(false); }
        }
      } catch (e) {
        logError('state-reader.poll', e);
        setState(EMPTY_STATE); setIsAvailable(false); lastDataVersion.current = 0;
      } finally {
        db?.close(false);
      }
    }, POLL_INTERVAL);

    return () => clearInterval(timer);
  }, []);

  return { state, isAvailable };
}
```

**Step 6: Run tests**

Run: `bun test test/dashboard-hooks.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add src/dashboard/hooks/ test/dashboard-hooks.test.ts
git commit -m "feat(dashboard): extract tree/feed/status/state-reader into React hooks"
```

---

### Task 3: Build TreePanel Component

**Files:**
- Create: `src/dashboard/components/TreePanel.tsx`
- Test: `test/dashboard-ink.test.tsx`

**Step 1: Write the test**

```tsx
// test/dashboard-ink.test.tsx
import { describe, expect, test } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { TreePanel } from '../src/dashboard/components/TreePanel.tsx';
import type { TreeNode } from '../src/dashboard/hooks/useTree.ts';

describe('TreePanel', () => {
  test('renders room with agent showing role', () => {
    const nodes: TreeNode[] = [
      { type: 'room', id: 'room:co', label: 'co', memberCount: 1 },
      { type: 'agent', id: 'agent:boss', label: 'boss', agentName: 'boss', role: 'boss', status: 'idle' },
    ];
    const { lastFrame } = render(<TreePanel nodes={nodes} selectedIndex={1} height={10} />);
    const frame = lastFrame()!;
    expect(frame).toContain('co');
    expect(frame).toContain('boss');
    expect(frame).toContain('boss'); // role shown
  });

  test('shows collapse indicator on rooms', () => {
    const nodes: TreeNode[] = [
      { type: 'room', id: 'room:co', label: 'co', memberCount: 2, collapsed: true },
    ];
    const { lastFrame } = render(<TreePanel nodes={nodes} selectedIndex={0} height={10} />);
    expect(lastFrame()!).toContain('▶');
  });

  test('secondary agents render with dim marker', () => {
    const nodes: TreeNode[] = [
      { type: 'room', id: 'room:fe', label: 'fe', memberCount: 1 },
      { type: 'agent', id: 'agent:lead:fe', label: 'lead', agentName: 'lead', role: 'leader', status: 'busy', secondary: true },
    ];
    const { lastFrame } = render(<TreePanel nodes={nodes} selectedIndex={1} height={10} />);
    expect(lastFrame()!).toContain('◦');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/dashboard-ink.test.tsx`
Expected: FAIL — cannot resolve TreePanel

**Step 3: Implement TreePanel**

Create `src/dashboard/components/TreePanel.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { TreeNode } from '../hooks/useTree.ts';

const STATUS_COLORS: Record<string, string> = {
  idle: 'green', busy: 'yellow', dead: 'red', unknown: 'gray',
};

interface TreePanelProps {
  nodes: TreeNode[];
  selectedIndex: number;
  height: number;
}

export function TreePanel({ nodes, selectedIndex, height }: TreePanelProps) {
  const maxLines = Math.max(1, height - 2); // border top/bottom
  let startIdx = 0;
  if (selectedIndex >= maxLines) startIdx = selectedIndex - maxLines + 1;
  const visible = nodes.slice(startIdx, startIdx + maxLines);

  return (
    <Box flexDirection="column" borderStyle="single" width="30%" height={height}>
      {visible.map((node, i) => {
        const globalIdx = startIdx + i;
        const isSel = globalIdx === selectedIndex;

        if (node.type === 'room') {
          return (
            <Text key={node.id} inverse={isSel}>
              {' '}{node.collapsed ? '▶' : '▼'} {node.label} ({node.memberCount})
            </Text>
          );
        }

        const color = STATUS_COLORS[node.status ?? 'unknown'] ?? 'gray';
        const dot = node.secondary ? '◦' : '●';
        const roleSuffix = node.role ? ` (${node.role})` : '';

        return (
          <Text key={node.id} inverse={isSel} dimColor={node.secondary}>
            {'   '}<Text color={node.secondary ? 'gray' : color}>{dot}</Text> {node.label}<Text dimColor>{roleSuffix}</Text>
          </Text>
        );
      })}
      {startIdx > 0 && <Text dimColor>{'  '}▲ more</Text>}
      {startIdx + maxLines < nodes.length && <Text dimColor>{'  '}▼ more</Text>}
    </Box>
  );
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/dashboard-ink.test.tsx`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/dashboard/components/TreePanel.tsx test/dashboard-ink.test.tsx
git commit -m "feat(dashboard): add Ink TreePanel component with role display"
```

---

### Task 4: Build MessageFeed Component

**Files:**
- Create: `src/dashboard/components/MessageFeed.tsx`
- Modify: `test/dashboard-ink.test.tsx`

**Step 1: Add test to dashboard-ink.test.tsx**

```tsx
import { MessageFeedPanel } from '../src/dashboard/components/MessageFeed.tsx';
import type { FormattedMessage } from '../src/dashboard/hooks/useFeed.ts';

describe('MessageFeedPanel', () => {
  test('renders messages with kind badges', () => {
    const msgs: FormattedMessage[] = [
      { id: '1', timestamp: '14:32:01', sender: 'boss', room: 'co', target: 'w1', text: 'Build login', kind: 'task', roomColor: 'cyan' },
      { id: '2', timestamp: '14:33:00', sender: 'w1', room: 'co', target: 'boss', text: 'Done', kind: 'completion', roomColor: 'cyan' },
    ];
    const { lastFrame } = render(<MessageFeedPanel messages={msgs} roomFilter={null} height={10} />);
    const frame = lastFrame()!;
    expect(frame).toContain('TASK');
    expect(frame).toContain('DONE');
    expect(frame).toContain('Build login');
  });

  test('filters by room when roomFilter is set', () => {
    const msgs: FormattedMessage[] = [
      { id: '1', timestamp: '14:32:01', sender: 'boss', room: 'co', target: 'ALL', text: 'hello', kind: 'chat', roomColor: 'cyan' },
      { id: '2', timestamp: '14:33:00', sender: 'w1', room: 'fe', target: 'ALL', text: 'world', kind: 'chat', roomColor: 'magenta' },
    ];
    const { lastFrame } = render(<MessageFeedPanel messages={msgs} roomFilter="fe" height={10} />);
    const frame = lastFrame()!;
    expect(frame).toContain('world');
    expect(frame).not.toContain('hello');
  });

  test('shows empty state', () => {
    const { lastFrame } = render(<MessageFeedPanel messages={[]} roomFilter={null} height={10} />);
    expect(lastFrame()!).toContain('No messages');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/dashboard-ink.test.tsx`
Expected: FAIL — cannot resolve MessageFeed

**Step 3: Implement MessageFeedPanel**

Create `src/dashboard/components/MessageFeed.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { FormattedMessage } from '../hooks/useFeed.ts';

const KIND_COLORS: Record<string, string> = {
  task: 'cyan', completion: 'green', error: 'red', question: 'yellow',
};
const KIND_BADGES: Record<string, string> = {
  task: '[TASK]', completion: '[DONE]', error: '[ERR]', question: '[?]',
};

interface MessageFeedPanelProps {
  messages: FormattedMessage[];
  roomFilter: string | null;
  height: number;
}

export function MessageFeedPanel({ messages, roomFilter, height }: MessageFeedPanelProps) {
  const maxLines = Math.max(1, height - 2);
  const filtered = roomFilter ? messages.filter(m => m.room === roomFilter) : messages;
  const visible = filtered.slice(-maxLines);
  const title = roomFilter ? `Messages [${roomFilter}]` : 'Messages';

  return (
    <Box flexDirection="column" borderStyle="single" height={height}>
      <Text bold> {title} </Text>
      {visible.length === 0 && <Text dimColor> No messages yet</Text>}
      {visible.map(msg => {
        const badge = KIND_BADGES[msg.kind];
        const badgeColor = KIND_COLORS[msg.kind];
        return (
          <Text key={msg.id} wrap="truncate">
            {' '}<Text dimColor>{msg.timestamp}</Text>
            {badge && <Text color={badgeColor}> {badge}</Text>}
            {' '}<Text color={msg.roomColor}>[{msg.sender}@{msg.room}]</Text>
            {' '}→ {msg.target === 'ALL' ? <Text bold>ALL</Text> : <Text>{msg.target}</Text>}
            : {msg.text.replace(/[\n\r]/g, ' ')}
          </Text>
        );
      })}
      {filtered.length > maxLines && <Text dimColor> ↑ {filtered.length - maxLines} more</Text>}
    </Box>
  );
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/dashboard-ink.test.tsx`
Expected: PASS (6 tests total)

**Step 5: Commit**

```bash
git add src/dashboard/components/MessageFeed.tsx test/dashboard-ink.test.tsx
git commit -m "feat(dashboard): add Ink MessageFeedPanel component"
```

---

### Task 5: Build DetailsPanel with Task Summary

**Files:**
- Create: `src/dashboard/components/DetailsPanel.tsx`
- Create: `src/dashboard/hooks/useTaskSummary.ts`
- Modify: `test/dashboard-ink.test.tsx`

**Step 1: Add tests**

Add to `test/dashboard-ink.test.tsx`:

```tsx
import { DetailsPanel } from '../src/dashboard/components/DetailsPanel.tsx';
import type { AgentStatusEntry } from '../src/dashboard/hooks/useStatus.ts';
import type { Agent, Room, Message } from '../src/shared/types.ts';

describe('DetailsPanel', () => {
  test('shows agent details with role and status', () => {
    const agent: Agent = { agent_id: 'l1', name: 'lead-1', role: 'leader', rooms: ['co'], tmux_target: '%101', joined_at: '2026-01-01' };
    const status: AgentStatusEntry = { status: 'busy', lastChange: Date.now(), rawOutput: 'Working...' };
    const { lastFrame } = render(
      <DetailsPanel agent={agent} agentStatus={status} selectedNode={{ type: 'agent', id: 'agent:lead-1', label: 'lead-1' }} rooms={{}} messages={[]} isSyncing={false} height={10} />
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
      <DetailsPanel agent={agent} agentStatus={status} selectedNode={{ type: 'agent', id: 'agent:lead-1', label: 'lead-1' }} rooms={{}} messages={[]} isSyncing={false} height={15} />
    );
    expect(lastFrame()!).toContain('pane');
  });

  test('shows task summary when room selected', () => {
    const messages: Message[] = [
      { message_id: '1', from: 'boss', room: 'fe', to: 'w1', text: 'do auth', kind: 'task', timestamp: '', sequence: 1, mode: 'push' },
      { message_id: '2', from: 'boss', room: 'fe', to: 'w1', text: 'do api', kind: 'task', timestamp: '', sequence: 2, mode: 'push' },
      { message_id: '3', from: 'w1', room: 'fe', to: 'boss', text: 'auth done', kind: 'completion', timestamp: '', sequence: 3, mode: 'push' },
      { message_id: '4', from: 'w1', room: 'fe', to: 'boss', text: 'api failed', kind: 'error', timestamp: '', sequence: 4, mode: 'push' },
    ];
    const rooms: Record<string, Room> = { fe: { name: 'fe', members: ['boss', 'w1'], created_at: '', topic: 'Frontend' } };
    const { lastFrame } = render(
      <DetailsPanel agent={null} agentStatus={null} selectedNode={{ type: 'room', id: 'room:fe', label: 'fe', memberCount: 2 }} rooms={rooms} messages={messages} isSyncing={false} height={12} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Task Summary');
    expect(frame).toContain('2');  // tasks
    expect(frame).toContain('1');  // completed (at least appears)
  });

  test('shows syncing state', () => {
    const { lastFrame } = render(
      <DetailsPanel agent={null} agentStatus={null} selectedNode={null} rooms={{}} messages={[]} isSyncing={true} height={10} />
    );
    expect(lastFrame()!).toContain('Syncing');
  });
});
```

**Step 2: Run to verify failure**

Run: `bun test test/dashboard-ink.test.tsx`
Expected: FAIL

**Step 3: Implement useTaskSummary hook**

Create `src/dashboard/hooks/useTaskSummary.ts`:

```ts
import { useMemo } from 'react';
import type { Message } from '../../shared/types.ts';

export interface TaskSummary {
  tasks: number;
  completed: number;
  errors: number;
  questions: number;
  open: number;
}

export function useTaskSummary(messages: Message[], room: string | null): TaskSummary | null {
  return useMemo(() => {
    if (!room) return null;
    const roomMsgs = messages.filter(m => m.room === room);
    const tasks = roomMsgs.filter(m => m.kind === 'task').length;
    const completed = roomMsgs.filter(m => m.kind === 'completion').length;
    const errors = roomMsgs.filter(m => m.kind === 'error').length;
    const questions = roomMsgs.filter(m => m.kind === 'question').length;
    if (tasks === 0 && completed === 0 && errors === 0) return null;
    return { tasks, completed, errors, questions, open: Math.max(0, tasks - completed - errors) };
  }, [messages, room]);
}
```

**Step 4: Implement DetailsPanel**

Create `src/dashboard/components/DetailsPanel.tsx`:

```tsx
import React from 'react';
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

export function DetailsPanel({ agent, agentStatus, selectedNode, rooms, messages, isSyncing, height }: DetailsPanelProps) {
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
}

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

  // Last activity
  let ago = '';
  if (agent.last_activity) {
    const secs = Math.floor((Date.now() - new Date(agent.last_activity).getTime()) / 1000);
    ago = secs < 60 ? `${secs}s ago` : secs < 3600 ? `${Math.floor(secs / 60)}m ago` : `${Math.floor(secs / 3600)}h ago`;
  }

  // Pane output
  const rawOutput = status?.rawOutput;
  const maxPaneLines = Math.max(0, height - 8); // Reserve lines for static info
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
```

**Step 5: Run test to verify it passes**

Run: `bun test test/dashboard-ink.test.tsx`
Expected: PASS (10 tests total)

**Step 6: Commit**

```bash
git add src/dashboard/components/DetailsPanel.tsx src/dashboard/hooks/useTaskSummary.ts test/dashboard-ink.test.tsx
git commit -m "feat(dashboard): add Ink DetailsPanel with task summary feature"
```

---

### Task 6: Build StatusBar and HelpOverlay Components

**Files:**
- Create: `src/dashboard/components/StatusBar.tsx`
- Create: `src/dashboard/components/HelpOverlay.tsx`
- Modify: `test/dashboard-ink.test.tsx`

**Step 1: Add tests**

```tsx
import { StatusBar } from '../src/dashboard/components/StatusBar.tsx';
import { HelpOverlay } from '../src/dashboard/components/HelpOverlay.tsx';

describe('StatusBar', () => {
  test('shows navigation shortcuts', () => {
    const { lastFrame } = render(<StatusBar hasErrors={false} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Navigate');
    expect(frame).toContain('Quit');
  });

  test('shows error indicator when hasErrors', () => {
    const { lastFrame } = render(<StatusBar hasErrors={true} />);
    expect(lastFrame()!).toContain('[!]');
  });
});

describe('HelpOverlay', () => {
  test('shows key bindings', () => {
    const { lastFrame } = render(<HelpOverlay />);
    const frame = lastFrame()!;
    expect(frame).toContain('Help');
    expect(frame).toContain('Move up');
    expect(frame).toContain('Quit');
  });
});
```

**Step 2: Run to verify failure, then implement**

Create `src/dashboard/components/StatusBar.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  hasErrors: boolean;
}

export function StatusBar({ hasErrors }: StatusBarProps) {
  return (
    <Box height={1}>
      <Text dimColor>↑↓/jk:Navigate  Enter:Toggle  ?:Help  q:Quit</Text>
      {hasErrors && <Text color="red"> [!]</Text>}
    </Box>
  );
}
```

Create `src/dashboard/components/HelpOverlay.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';

export function HelpOverlay() {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold> Help </Text>
      <Text>  ↑/k    Move up</Text>
      <Text>  ↓/j    Move down</Text>
      <Text>  gg     Jump to top</Text>
      <Text>  G      Jump to bottom</Text>
      <Text>  Enter  Toggle collapse</Text>
      <Text>  ?      Toggle this help</Text>
      <Text>  q      Quit</Text>
    </Box>
  );
}
```

**Step 3: Run test to verify it passes**

Run: `bun test test/dashboard-ink.test.tsx`
Expected: PASS (14 tests total)

**Step 4: Commit**

```bash
git add src/dashboard/components/StatusBar.tsx src/dashboard/components/HelpOverlay.tsx test/dashboard-ink.test.tsx
git commit -m "feat(dashboard): add Ink StatusBar and HelpOverlay components"
```

---

### Task 7: Build App.tsx — Wire Everything Together

**Files:**
- Create: `src/dashboard/App.tsx`
- Modify: `src/dashboard.ts` (entry point)

**Step 1: Implement App.tsx**

```tsx
import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { useStateReader } from './hooks/useStateReader.ts';
import { useTree } from './hooks/useTree.ts';
import { useFeed } from './hooks/useFeed.ts';
import { useStatus } from './hooks/useStatus.ts';
import { TreePanel } from './components/TreePanel.tsx';
import { MessageFeedPanel } from './components/MessageFeed.tsx';
import { DetailsPanel } from './components/DetailsPanel.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { HelpOverlay } from './components/HelpOverlay.tsx';
import { hasErrors, logError } from './logger.ts';

const POLL_INTERVAL = 2000;

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 80;

  const { state, isAvailable } = useStateReader();
  const { statuses, pollAll, getStatus } = useStatus();
  const { messages, update: updateFeed } = useFeed();
  const tree = useTree(state.agents, state.rooms, statuses);
  const [showHelp, setShowHelp] = useState(false);

  // Update feed when state changes
  useEffect(() => { updateFeed(state.messages); }, [state.messages]);

  // Poll agent statuses
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        if (Object.keys(state.agents).length > 0) await pollAll(state.agents);
      } catch (e) { logError('app.poll', e); }
    }, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [state.agents, pollAll]);

  // Keyboard handling
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) { exit(); return; }
    if (input === '?') { setShowHelp(h => !h); return; }
    if (input === 'k' || key.upArrow) { tree.moveUp(); return; }
    if (input === 'j' || key.downArrow) { tree.moveDown(); return; }
    if (input === 'g') { tree.moveToTop(); return; } // simplified: single g instead of gg
    if (input === 'G') { tree.moveToBottom(); return; }
    if (key.return) { tree.toggleCollapse(); return; }
  });

  if (!isAvailable) {
    return (
      <Box flexDirection="column" height={rows} width={cols} justifyContent="center" alignItems="center">
        <Text dimColor>Waiting for cc-tmux...</Text>
      </Box>
    );
  }

  const agent = tree.selectedAgentName ? state.agents[tree.selectedAgentName] ?? null : null;
  const agentStatus = tree.selectedAgentName ? getStatus(tree.selectedAgentName) : null;
  const isSyncing = tree.selectedAgentName !== null && agent === null;

  const topH = Math.max(5, Math.floor((rows - 1) * 0.65));
  const bottomH = rows - 1 - topH;

  return (
    <Box flexDirection="column" height={rows} width={cols}>
      <Box flexDirection="row" flexGrow={1}>
        <TreePanel nodes={tree.nodes} selectedIndex={tree.selectedIndex} height={rows - 1} />
        <Box flexDirection="column" flexGrow={1}>
          <MessageFeedPanel messages={messages} roomFilter={tree.selectedRoomName} height={topH} />
          <DetailsPanel
            agent={agent}
            agentStatus={agentStatus}
            selectedNode={tree.selectedNode}
            rooms={state.rooms}
            messages={state.messages}
            isSyncing={isSyncing}
            height={bottomH}
          />
        </Box>
      </Box>
      <StatusBar hasErrors={hasErrors()} />
      {showHelp && <HelpOverlay />}
    </Box>
  );
}
```

**Step 2: Update entry point**

Modify `src/dashboard.ts`:

```ts
#!/usr/bin/env bun
import React from 'react';
import { render } from 'ink';
import { App } from './dashboard/App.tsx';

const { waitUntilExit } = render(React.createElement(App));
await waitUntilExit();
```

**Step 3: Verify it compiles**

Run: `bun build src/dashboard.ts --target=bun --outdir=/tmp/ink-build-test 2>&1 | head -5`
Expected: No TypeScript errors

**Step 4: Commit**

```bash
git add src/dashboard/App.tsx src/dashboard.ts
git commit -m "feat(dashboard): wire up Ink App component with all hooks and panels"
```

---

### Task 8: Delete Old Files and Update Tests

**Files:**
- Delete: `src/dashboard/terminal.ts`
- Delete: `src/dashboard/render.ts`
- Delete: `src/dashboard/tree.ts`
- Delete: `src/dashboard/feed.ts`
- Delete: `src/dashboard/status.ts`
- Delete: `src/dashboard/state-reader.ts`
- Delete: `src/dashboard/app.ts`
- Modify: `test/dashboard.test.ts` — rewrite to test new hooks/components

**Step 1: Delete old files**

```bash
rm src/dashboard/terminal.ts src/dashboard/render.ts src/dashboard/tree.ts src/dashboard/feed.ts src/dashboard/status.ts src/dashboard/state-reader.ts src/dashboard/app.ts
```

**Step 2: Replace dashboard.test.ts**

Rewrite `test/dashboard.test.ts` to import from new hook/component locations. The test assertions stay the same, but imports change from classes to hook pure functions:

```ts
import { describe, expect, test } from 'bun:test';
import { buildTree, type TreeNode } from '../src/dashboard/hooks/useTree.ts';
import type { Agent, Room, Message } from '../src/shared/types.ts';
import type { AgentStatusEntry } from '../src/dashboard/hooks/useStatus.ts';

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
    const statuses = new Map<string, AgentStatusEntry>([
      ['boss', { status: 'idle', lastChange: Date.now() - 5000 }],
      ['lead-1', { status: 'busy', lastChange: Date.now() - 1000 }],
      ['w1', { status: 'dead', lastChange: Date.now() }],
    ]);
    return { agents, rooms, statuses };
  }

  test('multi-room agents appear in each room', () => {
    const { agents, rooms, statuses } = setup();
    const nodes = buildTree(agents, rooms, statuses, new Set());
    expect(nodes.length).toBe(6);
  });

  test('secondary agent has room-scoped id', () => {
    const { agents, rooms, statuses } = setup();
    const nodes = buildTree(agents, rooms, statuses, new Set());
    const secondary = nodes.find(n => n.agentName === 'lead-1' && n.secondary);
    expect(secondary!.id).toBe('agent:lead-1:frontend');
  });

  test('room member count', () => {
    const { agents, rooms, statuses } = setup();
    const nodes = buildTree(agents, rooms, statuses, new Set());
    const fe = nodes.find(n => n.type === 'room' && n.label === 'frontend');
    expect(fe!.memberCount).toBe(2);
  });

  test('collapsed room hides members', () => {
    const { agents, rooms, statuses } = setup();
    const nodes = buildTree(agents, rooms, statuses, new Set(['company']));
    expect(nodes.find(n => n.agentName === 'boss')).toBeUndefined();
  });

  test('unassigned agents', () => {
    const agents: Record<string, Agent> = {
      ghost: { agent_id: 'ghost', name: 'ghost', role: 'worker', rooms: [], tmux_target: '%199', joined_at: '' },
    };
    const nodes = buildTree(agents, {}, new Map(), new Set());
    expect(nodes.find(n => n.id === 'room:__unassigned__')).toBeDefined();
  });
});
```

**Step 3: Run all tests**

Run: `bun test`
Expected: All tests pass across all test files

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor(dashboard): remove old ANSI renderer, update tests for Ink migration"
```

---

### Task 9: Manual Smoke Test and Fix Issues

**Step 1: Run the dashboard**

Run: `bun run dashboard`

Verify:
- Three panels render (tree, messages, details)
- j/k navigates the tree
- Enter collapses/expands rooms
- Agent role shows next to name: `● boss (boss)`
- Selecting a room shows task summary (if messages exist)
- ? toggles help overlay
- q exits cleanly

**Step 2: Fix any rendering issues found**

Common issues to check:
- Box overflow (text wrapping into adjacent panels)
- Color not appearing
- Borders misaligned
- Keyboard not responding

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix(dashboard): post-migration rendering fixes"
```

---

### Task 10: Update Documentation

**Files:**
- Modify: `docs/architecture.md`
- Modify: `README.md`

**Step 1: Update architecture docs**

Update `docs/architecture.md` dashboard section to reflect:
- Ink component architecture (App → Layout → TreePanel + MessageFeed + DetailsPanel + StatusBar + HelpOverlay)
- Hook-based data flow (useStateReader → useTree/useFeed/useStatus → components)
- Dependencies: ink, react, @inkjs/ui
- New features: role in tree, task summary

**Step 2: Update README**

Update `README.md` dashboard usage section if it references old files or architecture.

**Step 3: Commit**

```bash
git add docs/architecture.md README.md
git commit -m "docs: update architecture and README for Ink dashboard migration"
```
