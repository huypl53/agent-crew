# Dashboard TUI Bug Fixes & UX Enhancement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 7 confirmed TUI bugs (frozen state, jumping selection, box corruption, blank details, wrong counts, silent errors, invisible agents) and add 2 UX enhancements (live pane output, multi-room display).

**Architecture:** All changes are in `src/dashboard/`. The state-reader uses `PRAGMA data_version` for full-DB change detection. Tree tracking switches from index-based to ID-based. The details panel shows raw tmux pane output filling available rows. Multi-room agents appear under each room with a dim/hollow secondary style.

**Tech Stack:** Bun + TypeScript, ANSI terminal rendering, bun:sqlite, tmux capture-pane.

**Design doc:** `docs/plans/2026-04-06-dashboard-tui-design.md`

---

### Task 1: Error logger module

**Files:**
- Create: `src/dashboard/logger.ts`

**Step 1: Write the implementation**

```ts
// src/dashboard/logger.ts
import { appendFileSync } from 'fs';

export const LOG_PATH = '/tmp/cc-tmux/dashboard.log';
let errorCount = 0;

export function logError(ctx: string, err: unknown): void {
  errorCount++;
  const msg = err instanceof Error ? err.message : String(err);
  const line = `${new Date().toISOString()} [${ctx}] ${msg}\n`;
  try { appendFileSync(LOG_PATH, line); } catch { /* nowhere to report */ }
}

export function hasErrors(): boolean { return errorCount > 0; }
export function resetErrors(): void { errorCount = 0; }  // for tests
```

**Step 2: Verify it compiles**

```bash
bun build src/dashboard/logger.ts --target bun 2>&1
```

Expected: no errors

**Step 3: Commit**

```bash
git add src/dashboard/logger.ts
git commit -m "feat(dashboard): add error logger to file instead of console.error"
```

---

### Task 2: Fix state-reader change detection (Bug 1)

**Files:**
- Modify: `src/dashboard/state-reader.ts`

The dashboard currently polls `SELECT MAX(id) FROM messages` — this misses agent registrations, room changes, and topic updates. Replace with `PRAGMA data_version` which increments on ANY committed write from any connection.

**Step 1: Locate and update the poll logic**

In `src/dashboard/state-reader.ts`, find the `startPolling` method. Change the change detection query:

```ts
// Before (line ~173):
const row = this.db.query('SELECT MAX(id) as max FROM messages').get() as { max: number | null };
const maxId = row?.max ?? 0;
if (maxId !== this.lastMaxId) {
  this.lastMaxId = maxId;
  this.readAll();
  this.onChange?.(this.state);
}

// After:
const row = this.db.query('PRAGMA data_version').get() as { data_version: number };
const v = row?.data_version ?? 0;
if (v !== this.lastVersion) {
  this.lastVersion = v;
  this.readAll();
  this.onChange?.(this.state);
}
```

Also rename the field `lastMaxId` → `lastVersion` everywhere in the file (it's only used in `startPolling` and `readAll`).

In `readAll()`, remove the line that sets `this.lastMaxId = ...` (it no longer needs to be set there — `startPolling` owns the version tracking).

**Step 2: Run existing tests**

```bash
bun test test/dashboard.test.ts 2>&1
```

Expected: all pass (state-reader isn't directly tested, just compiled)

**Step 3: Commit**

```bash
git add src/dashboard/state-reader.ts
git commit -m "fix(dashboard): detect all DB changes via PRAGMA data_version, not MAX(messages.id)"
```

---

### Task 3: Fix shortcut bar layout — reserve last row (Bug 2)

**Files:**
- Modify: `src/dashboard/render.ts:101-109`

The shortcut bar at `moveTo(size.rows-1, 0)` with `padEnd(size.cols)` overwrites the bottom border of all 3 boxes. Fix: reduce all box heights by 1 to use only `size.rows - 1` rows for boxes, leaving the last row exclusively for the shortcut bar.

**Step 1: Update renderFrame layout calculation**

In `src/dashboard/render.ts`, find the layout constants block (~line 101):

```ts
// Before:
const leftW = Math.max(20, Math.floor(size.cols * 0.3));
const rightW = size.cols - leftW;
const topH = Math.max(5, Math.floor(size.rows * 0.65));
const bottomH = size.rows - topH;
const msgTitle = roomFilter ? `Messages [${roomFilter}]` : 'Messages';

buf += drawBox(0, 0, leftW, size.rows, 'Rooms & Agents');
buf += drawBox(leftW, 0, rightW, topH, msgTitle);
buf += drawBox(leftW, topH, rightW, bottomH, 'Details');

// After:
const leftW = Math.max(20, Math.floor(size.cols * 0.3));
const rightW = size.cols - leftW;
const usableRows = size.rows - 1;   // last row reserved for shortcut bar
const topH = Math.max(5, Math.floor(usableRows * 0.65));
const bottomH = usableRows - topH;
const msgTitle = roomFilter ? `Messages [${roomFilter}]` : 'Messages';

buf += drawBox(0, 0, leftW, usableRows, 'Rooms & Agents');
buf += drawBox(leftW, 0, rightW, topH, msgTitle);
buf += drawBox(leftW, topH, rightW, bottomH, 'Details');
```

Also update the tree `treeMaxLines` that was derived from `size.rows`:
```ts
// Before:
const treeMaxLines = size.rows - 2;

// After:
const treeMaxLines = usableRows - 2;
```

**Step 2: Write test that boxes don't write on last row**

Add to `test/dashboard.test.ts` in the `dashboard render` describe block:

```ts
test('shortcut bar is on last row and boxes do not overlap it', () => {
  const size = { cols: 80, rows: 24 };
  const frame = renderFrame(size, [], 0, [], null, null, true);
  // The bottom border of boxes should be at row 22 (0-indexed), not row 23
  // moveTo(22, x) = ESC[23;...H  (1-indexed in ANSI)
  // moveTo(23, x) = ESC[24;...H — this is the shortcut bar row
  // Verify shortcut bar content appears at row 24 (1-indexed)
  expect(frame).toContain('\x1b[24;1H');           // shortcut bar at last row
  expect(frame).toContain('↑↓/jk:Navigate');
});
```

**Step 3: Run test to verify it passes**

```bash
bun test test/dashboard.test.ts --test-name-pattern "shortcut bar" 2>&1
```

Expected: PASS

**Step 4: Commit**

```bash
git add src/dashboard/render.ts test/dashboard.test.ts
git commit -m "fix(dashboard): reserve last terminal row for shortcut bar, boxes stop at rows-2"
```

---

### Task 4: ID-based selection tracking (Bug 3)

**Files:**
- Modify: `src/dashboard/tree.ts`

Currently `selectedIndex` is a numeric offset. When `build()` reorders nodes (agent joins/leaves), the index points to a different agent. Fix: track `selectedId: string` (the node's `.id` field) and rederive `selectedIndex` after each build.

**Step 1: Write the failing test**

Add to `test/dashboard.test.ts` in the `dashboard tree` describe block:

```ts
test('selection survives tree rebuild with new agent inserted before selected', () => {
  const tree = new TreeState();
  const { agents, rooms, statuses } = setup();
  tree.build(agents, rooms, statuses);

  // Manually select 'boss' (index depends on build order — find it)
  const bossIdx = tree.items.findIndex(n => n.agentName === 'boss');
  tree.moveToTop();
  for (let i = 0; i < bossIdx; i++) tree.moveDown();
  expect(tree.selectedAgentName).toBe('boss');

  // Add a new agent to company that sorts before 'boss' alphabetically
  const agents2 = { ...agents, aardvark: { agent_id: 'aardvark', name: 'aardvark', role: 'worker' as const, rooms: ['company'], tmux_target: '%199', joined_at: '' } };
  const rooms2 = { ...rooms, company: { ...rooms.company, members: ['aardvark', 'boss', 'lead-1'] } };
  tree.build(agents2, rooms2, statuses);

  // Selection should still be 'boss', not shifted to 'aardvark'
  expect(tree.selectedAgentName).toBe('boss');
});
```

**Step 2: Run to verify it fails**

```bash
bun test test/dashboard.test.ts --test-name-pattern "selection survives" 2>&1
```

Expected: FAIL (selection shifts to wrong node)

**Step 3: Implement ID-based tracking in `tree.ts`**

Replace the `private selectedIndex` and `private autoSelect` fields with:

```ts
private _selectedIndex = -1;
private selectedId: string | null = null;
private autoSelect = true;
private collapsedRooms = new Set<string>();
private lastMostRecentAgent: string | null = null;

get selected(): number { return this._selectedIndex; }
```

Update `build()` — after constructing `nodes`, restore selection by ID:

```ts
this.nodes = nodes;

// Auto-select most recently active agent (only when not manually navigated)
if (this.autoSelect && mostRecent && mostRecent !== this.lastMostRecentAgent) {
  this.lastMostRecentAgent = mostRecent;
  const idx = nodes.findIndex(n => n.type === 'agent' && n.agentName === mostRecent);
  if (idx >= 0) { this._selectedIndex = idx; this.selectedId = nodes[idx]!.id; }
}

// Restore selection by ID (survives reorders and insertions)
if (this.selectedId) {
  const idx = nodes.findIndex(n => n.id === this.selectedId);
  if (idx >= 0) this._selectedIndex = idx;
}

// Fallback to first agent if no selection
if (this._selectedIndex < 0 && nodes.length > 0) {
  const first = nodes.findIndex(n => n.type === 'agent');
  this._selectedIndex = first >= 0 ? first : 0;
  this.selectedId = nodes[this._selectedIndex]?.id ?? null;
}
if (this._selectedIndex >= nodes.length) {
  this._selectedIndex = Math.max(0, nodes.length - 1);
  this.selectedId = nodes[this._selectedIndex]?.id ?? null;
}
```

Update movement methods to also set `selectedId`:

```ts
moveUp(): void {
  this.autoSelect = false;
  if (this._selectedIndex > 0) {
    this._selectedIndex--;
    this.selectedId = this.nodes[this._selectedIndex]?.id ?? null;
  }
}
moveDown(): void {
  this.autoSelect = false;
  if (this._selectedIndex < this.nodes.length - 1) {
    this._selectedIndex++;
    this.selectedId = this.nodes[this._selectedIndex]?.id ?? null;
  }
}
moveToTop(): void {
  this.autoSelect = false;
  if (this.nodes.length > 0) {
    this._selectedIndex = 0;
    this.selectedId = this.nodes[0]?.id ?? null;
  }
}
moveToBottom(): void {
  this.autoSelect = false;
  if (this.nodes.length > 0) {
    this._selectedIndex = this.nodes.length - 1;
    this.selectedId = this.nodes[this._selectedIndex]?.id ?? null;
  }
}
```

**Step 4: Run tests**

```bash
bun test test/dashboard.test.ts 2>&1
```

Expected: all pass including the new stability test

**Step 5: Commit**

```bash
git add src/dashboard/tree.ts test/dashboard.test.ts
git commit -m "fix(dashboard): track selection by node ID, survives tree rebuilds and insertions"
```

---

### Task 5: StatusPoller — store raw pane output (Enhancement A prep)

**Files:**
- Modify: `src/dashboard/status.ts`

**Step 1: Update `AgentStatusEntry` and `pollOne`**

In `src/dashboard/status.ts`:

Change the interface:
```ts
// Before:
export interface AgentStatusEntry {
  status: AgentStatus;
  lastChange: number;
  summary?: string;
}

// After:
export interface AgentStatusEntry {
  status: AgentStatus;
  lastChange: number;
  rawOutput?: string;   // full capture-pane output, NOT pre-sliced
}
```

Remove the `extractSummary()` function and `truncateLine()` helper entirely (they are replaced by the renderer slicing `rawOutput` to fit available rows).

Update `pollOne()` to store raw output:
```ts
private async pollOne(agent: Agent): Promise<AgentStatusEntry> {
  try {
    if (await isPaneDead(agent.tmux_target)) {
      return { status: 'dead', lastChange: Date.now() };
    }
    const output = await capturePane(agent.tmux_target);
    if (output === null) return { status: 'unknown', lastChange: Date.now() };
    return { status: matchStatusLine(output), lastChange: Date.now(), rawOutput: output };
  } catch (e) {
    logError('status.pollOne', e);
    return { status: 'unknown', lastChange: Date.now() };
  }
}
```

Add import at top: `import { logError } from './logger.ts';`

**Step 2: Update the existing render test that uses `summary`**

In `test/dashboard.test.ts`, update the agent details render test to use `rawOutput`:

```ts
// Before (~line 47):
{ status: 'busy', lastChange: Date.now(), summary: 'Editing src/Login.tsx' },
// ...
expect(frame).toContain('Editing src/Login.tsx');

// After:
{ status: 'busy', lastChange: Date.now(), rawOutput: 'Editing src/Login.tsx\nsome other output' },
// ...
expect(frame).toContain('Editing src/Login.tsx');
```

**Step 3: Run tests**

```bash
bun test test/dashboard.test.ts 2>&1
```

Expected: all pass

**Step 4: Commit**

```bash
git add src/dashboard/status.ts test/dashboard.test.ts
git commit -m "feat(dashboard): store full raw pane output in StatusPoller for live details view"
```

---

### Task 6: Live pane output in details panel (Enhancement A)

**Files:**
- Modify: `src/dashboard/render.ts` (details panel section, ~lines 196-237)
- Modify: `src/dashboard/app.ts` (add `isSyncing`, Bug 4)

**Step 1: Update `renderFrame` signature**

Add `isSyncing = false` as the last parameter:

```ts
export function renderFrame(
  size: TerminalSize, treeNodes: TreeNode[], selectedIndex: number,
  feedMessages: FormattedMessage[], selectedAgent: Agent | null,
  selectedAgentStatus: AgentStatusEntry | null, stateAvailable: boolean,
  roomFilter: string | null = null, rooms?: Record<string, Room>,
  showHelp = false, isSyncing = false,
): string
```

**Step 2: Rewrite the details panel section**

Replace lines ~196-237 (the details panel block) with:

```ts
// Details panel
const detailCol = leftW + 2;
const detailBoxEnd = topH + bottomH - 1;  // last row of details box interior
let detailRow = topH + 1;

if (!selectedAgent) {
  const selectedNode = treeNodes[selectedIndex];
  if (selectedNode?.type === 'room') {
    const roomName = selectedNode.label;
    const room = rooms?.[roomName] as (Room & { topic?: string }) | undefined;
    buf += moveTo(detailRow++, detailCol) + `${COLORS.bold}${roomName}${COLORS.reset}`;
    if (room?.topic) buf += moveTo(detailRow++, detailCol) + `Topic: ${room.topic}`;
    buf += moveTo(detailRow++, detailCol) + `Members: ${selectedNode.memberCount}`;
  } else if (isSyncing) {
    buf += moveTo(detailRow, detailCol) + COLORS.dim + 'Syncing…' + COLORS.reset;
  } else {
    buf += moveTo(detailRow, detailCol) + COLORS.dim + 'No agent selected' + COLORS.reset;
  }
} else {
  const status = selectedAgentStatus?.status ?? 'unknown';
  const sc = STATUS_COLORS[status];
  const roomTopic = roomFilter ? rooms?.[roomFilter]?.topic : undefined;

  // Static info block (compressed to 5 lines max)
  buf += moveTo(detailRow++, detailCol) + `${COLORS.bold}${selectedAgent.name}${COLORS.reset}`;
  buf += moveTo(detailRow++, detailCol) + `${sc}${status}${COLORS.reset}  ${COLORS.dim}${selectedAgent.role} · ${selectedAgent.tmux_target}${COLORS.reset}`;
  buf += moveTo(detailRow++, detailCol) + `Rooms: ${selectedAgent.rooms.join(', ')}`;
  if (roomTopic) buf += moveTo(detailRow++, detailCol) + `Topic: ${truncate(roomTopic, rightW - 6)}`;
  if (selectedAgent.last_activity) {
    const secs = Math.floor((Date.now() - new Date(selectedAgent.last_activity).getTime()) / 1000);
    const ago = secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs / 60)}m` : `${Math.floor(secs / 3600)}h`;
    buf += moveTo(detailRow++, detailCol) + `Last: ${COLORS.dim}${ago} ago${COLORS.reset}`;
  }

  // Live pane output fills remaining rows
  const rawOutput = selectedAgentStatus?.rawOutput;
  if (rawOutput && detailRow < detailBoxEnd - 1) {
    buf += moveTo(detailRow++, detailCol) + COLORS.dim + '─ pane ─' + COLORS.reset;
    const maxPaneRows = detailBoxEnd - detailRow - 1;
    const paneLines = rawOutput.split('\n').filter(l => l.trim()).slice(-maxPaneRows);
    for (const line of paneLines) {
      if (detailRow >= detailBoxEnd) break;
      buf += moveTo(detailRow++, detailCol) + COLORS.dim + truncate(line, rightW - 4) + COLORS.reset;
    }
  }
}
```

**Step 3: Update `app.ts` to pass `isSyncing`**

In `src/dashboard/app.ts`, update the `draw()` function:

```ts
function draw(): void {
  const state = stateReader.current;
  const agentName = tree.selectedAgentName;
  const agent = agentName ? state.agents[agentName] ?? null : null;
  const isSyncing = agentName !== null && agent === null;
  const status = agentName ? statusPoller.getStatus(agentName) : null;
  const roomFilter = tree.selectedRoomName;
  writeFrame(renderFrame(
    size, tree.items, tree.selected,
    feed.messages, agent, status,
    stateReader.isAvailable,
    roomFilter, state.rooms,
    showHelp, isSyncing,
  ));
}
```

Also add the logError import and wrap the poll timer catch:
```ts
// Add at top:
import { logError } from './logger.ts';

// Update poll timer catch (~line 60):
} catch (e) { logError('app.poll', e); }
```

**Step 4: Update render test for new signature and rawOutput**

In `test/dashboard.test.ts`, the agent details test should check that rawOutput appears:

```ts
test('renders agent details with live pane output', () => {
  const agent: Agent = { agent_id: 'l1', name: 'lead-1', role: 'leader', rooms: ['co', 'fe'], tmux_target: '%101', joined_at: '2026-01-01' };
  const rooms: Record<string, Room> = {
    fe: { name: 'fe', members: ['lead-1'], created_at: '', topic: 'Build login flow' },
  };
  const frame = renderFrame(
    { cols: 80, rows: 24 },
    [], 0, [],
    agent,
    { status: 'busy', lastChange: Date.now(), rawOutput: 'Working on auth.ts\nCompiling...' },
    true, 'fe', rooms,
  );
  expect(frame).toContain('lead-1');
  expect(frame).toContain('busy');
  expect(frame).toContain('Build login flow');
  expect(frame).toContain('Working on auth.ts');
  expect(frame).toContain('─ pane ─');
});

test('shows Syncing when agent name selected but not in state', () => {
  const nodes: TreeNode[] = [
    { type: 'agent', id: 'agent:ghost', label: 'ghost', agentName: 'ghost', role: 'worker', status: 'unknown' },
  ];
  const frame = renderFrame({ cols: 80, rows: 24 }, nodes, 0, [], null, null, true, null, undefined, false, true);
  expect(frame).toContain('Syncing');
});
```

**Step 5: Run tests**

```bash
bun test test/dashboard.test.ts 2>&1
```

Expected: all pass

**Step 6: Commit**

```bash
git add src/dashboard/render.ts src/dashboard/app.ts test/dashboard.test.ts
git commit -m "feat(dashboard): live pane output in details panel, fix blank agent details state"
```

---

### Task 7: Multi-room display + fix secondary visibility (Enhancement B = fixes Bug 5)

**Files:**
- Modify: `src/dashboard/tree.ts`
- Modify: `src/dashboard/render.ts`

**Step 1: Update `TreeNode` interface**

In `src/dashboard/tree.ts`, add `secondary` to the interface:

```ts
export interface TreeNode {
  type: 'room' | 'agent';
  id: string;
  label: string;
  memberCount?: number;
  collapsed?: boolean;
  agentName?: string;
  role?: string;
  status?: AgentStatus;
  extraRooms?: string[];   // kept for now but unused in rendering
  secondary?: boolean;     // true if agent appears as non-primary member of this room
}
```

**Step 2: Rewrite the agent loop in `build()`**

Replace the room member loop inside `build()` (currently filters to primary-only agents):

```ts
// Before (inside room loop):
const membersInRoom = room.members.filter(m => agentPrimary.get(m) === roomName);
nodes.push({ type: 'room', ... memberCount: membersInRoom.length, ... });
if (!this.collapsedRooms.has(roomName)) {
  for (const memberName of membersInRoom) { ... }
}

// After:
const membersInRoom = room.members;  // ALL members, not just primary
nodes.push({
  type: 'room', id: `room:${roomName}`, label: roomName,
  memberCount: membersInRoom.length,  // now accurate
  collapsed: this.collapsedRooms.has(roomName),
});
if (!this.collapsedRooms.has(roomName)) {
  for (const memberName of membersInRoom) {
    const agent = agents[memberName];
    if (!agent) continue;
    const isPrimary = agent.rooms[0] === roomName;
    // Secondary appearances use a room-scoped id so selection context is preserved
    const nodeId = isPrimary ? `agent:${memberName}` : `agent:${memberName}:${roomName}`;
    nodes.push({
      type: 'agent', id: nodeId, label: memberName,
      agentName: memberName, role: agent.role,
      status: statuses.get(memberName)?.status ?? 'unknown',
      secondary: !isPrimary,
    });
  }
}
```

Also remove the `agentPrimary` map construction that was used for primary-room filtering:

```ts
// Remove these lines from build():
const agentPrimary = new Map<string, string>();
for (const [name, agent] of Object.entries(agents)) {
  if (agent.rooms.length > 0) agentPrimary.set(name, agent.rooms[0]!);
}
```

**Step 3: Update render.ts for hollow dot on secondary agents**

In `src/dashboard/render.ts`, find the agent node rendering block (~line 132):

```ts
// Before:
} else {
  const sc = STATUS_COLORS[node.status ?? 'unknown'];
  const badge = node.extraRooms?.length ? ` ${COLORS.dim}[+${node.extraRooms[0]}]${COLORS.reset}` : '';
  line = `   ${sc}●${COLORS.reset} ${node.label}${badge}`;
}

// After:
} else {
  const sc = STATUS_COLORS[node.status ?? 'unknown'];
  const dot = node.secondary ? `${COLORS.dim}◦` : `${sc}●`;
  const nameStyle = node.secondary ? COLORS.dim : '';
  line = `   ${dot}${COLORS.reset} ${nameStyle}${node.label}${COLORS.reset}`;
}
```

**Step 4: Update tree tests**

The existing test `expect(tree.items.length).toBe(5)` was counting primary-only. With Enhancement B, lead-1 appears under both rooms:
- room:company, boss, lead-1(primary), room:frontend, lead-1(secondary), w1 → 6 nodes

Update the tree tests:

```ts
test('builds tree with rooms and agents — multi-room agents appear in each room', () => {
  const tree = new TreeState();
  const { agents, rooms, statuses } = setup();
  tree.build(agents, rooms, statuses);
  // lead-1 is in both rooms, so 2 rooms + 3 unique agents + 1 secondary = 6 nodes
  expect(tree.items.length).toBe(6);
  expect(tree.items[0]!.type).toBe('room');
  expect(tree.items[0]!.label).toBe('company');
});

test('secondary agent appearance is dim in non-primary room', () => {
  const tree = new TreeState();
  const { agents, rooms, statuses } = setup();
  tree.build(agents, rooms, statuses);
  // lead-1 appears under 'frontend' as secondary
  const secondary = tree.items.find(n => n.agentName === 'lead-1' && n.secondary);
  expect(secondary).toBeDefined();
  expect(secondary!.id).toBe('agent:lead-1:frontend');
});

test('room member count includes all members (not just primary)', () => {
  const tree = new TreeState();
  const { agents, rooms, statuses } = setup();
  tree.build(agents, rooms, statuses);
  const frontendRoom = tree.items.find(n => n.type === 'room' && n.label === 'frontend');
  expect(frontendRoom!.memberCount).toBe(2);  // lead-1 + w1
});

// Remove or update these old tests that conflict:
// - 'no duplicate agents across rooms' → remove (duplicates now intentional)
// - 'multi-room badge' → remove ([+room] badge is gone)
```

**Step 5: Run tests**

```bash
bun test test/dashboard.test.ts 2>&1
```

Expected: all pass

**Step 6: Commit**

```bash
git add src/dashboard/tree.ts src/dashboard/render.ts test/dashboard.test.ts
git commit -m "feat(dashboard): show agents under all rooms with secondary (dim+hollow) style"
```

---

### Task 8: Unassigned agents section (Bug 7)

**Files:**
- Modify: `src/dashboard/tree.ts` (end of `build()`)

**Step 1: Write failing test**

Add to `test/dashboard.test.ts`:

```ts
test('agents with no rooms appear in Unassigned section', () => {
  const tree = new TreeState();
  const agents: Record<string, Agent> = {
    ghost: { agent_id: 'ghost', name: 'ghost', role: 'worker', rooms: [], tmux_target: '%199', joined_at: '' },
  };
  const rooms: Record<string, Room> = {};
  tree.build(agents, rooms, new Map());
  const unassigned = tree.items.find(n => n.type === 'room' && n.id === 'room:__unassigned__');
  expect(unassigned).toBeDefined();
  const ghostNode = tree.items.find(n => n.agentName === 'ghost');
  expect(ghostNode).toBeDefined();
});
```

**Step 2: Run to confirm failure**

```bash
bun test test/dashboard.test.ts --test-name-pattern "Unassigned" 2>&1
```

Expected: FAIL

**Step 3: Add Unassigned section to `build()`**

At the end of `build()`, before the selection restore logic:

```ts
// Unassigned: agents with no rooms
const unassigned = Object.values(agents).filter(a => !a.rooms || a.rooms.length === 0);
if (unassigned.length > 0) {
  nodes.push({
    type: 'room', id: 'room:__unassigned__',
    label: '── Unassigned ──',
    memberCount: unassigned.length,
    collapsed: this.collapsedRooms.has('__unassigned__'),
  });
  if (!this.collapsedRooms.has('__unassigned__')) {
    for (const agent of unassigned) {
      nodes.push({
        type: 'agent', id: `agent:${agent.name}`,
        label: agent.name, agentName: agent.name,
        role: agent.role, status: statuses.get(agent.name)?.status ?? 'unknown',
      });
    }
  }
}
```

**Step 4: Run tests**

```bash
bun test test/dashboard.test.ts 2>&1
```

Expected: all pass

**Step 5: Commit**

```bash
git add src/dashboard/tree.ts test/dashboard.test.ts
git commit -m "fix(dashboard): show agents with no rooms in Unassigned section"
```

---

### Task 9: Wrap silent catch{} blocks (Bug 6)

**Files:**
- Modify: `src/dashboard/state-reader.ts`
- Modify: `src/dashboard/status.ts` (already done in Task 5)

**Step 1: Update state-reader.ts**

Import logError and replace empty catches:

```ts
// Add at top of state-reader.ts:
import { logError } from './logger.ts';

// In readAll() (~line 141):
// Before: } catch { /* DB may be mid-write; skip this tick */ }
// After:
} catch (e) { logError('state-reader.readAll', e); }

// In startPolling() error handler (~line 180):
// Before: } catch {
// After:
} catch (e) { logError('state-reader.poll', e); ... }
```

**Step 2: Update shortcut bar to show [!] on errors**

In `src/dashboard/render.ts`, update the shortcut bar line:

```ts
// Add import at top:
import { hasErrors } from './logger.ts';

// Update shortcut bar (~line 194):
// Before:
const shortcutBar = '↑↓/jk:Navigate  Enter:Toggle  ?:Help  q:Quit';
// After:
const errFlag = hasErrors() ? '  \x1b[31m[!]\x1b[0m' : '';
const shortcutBar = `↑↓/jk:Navigate  Enter:Toggle  ?:Help  q:Quit${errFlag}`;
```

**Step 3: Run full test suite**

```bash
bun test 2>&1 | tail -10
```

Expected: all tests pass, no errors

**Step 4: Commit**

```bash
git add src/dashboard/state-reader.ts src/dashboard/render.ts
git commit -m "fix(dashboard): log errors to file, show [!] indicator in shortcut bar"
```

---

### Task 10: Full verification

**Step 1: Run complete test suite**

```bash
bun test 2>&1
```

Expected: all tests pass (72+ pass, 0 fail)

**Step 2: Build check for all dashboard files**

```bash
bun build src/dashboard/index.ts --target bun 2>&1 | head -20
```

Expected: no errors

**Step 3: Check git log**

```bash
git log --oneline -8
```

Expected: the 8 commits from this plan visible

**Step 4: Update architecture.md if needed**

In `docs/architecture.md`, add a note to the TUI section about `PRAGMA data_version` polling and the live pane output feature.

```bash
git add docs/architecture.md
git commit -m "docs: document dashboard PRAGMA data_version polling and live pane output"
```
