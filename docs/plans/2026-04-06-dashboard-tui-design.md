# Dashboard TUI — Bug Fixes & UX Enhancement Design

**Date:** 2026-04-06
**Status:** Approved

## Problem Summary

The dashboard has 7 confirmed bugs (identified from code review + agent consultation) and one major UX gap. The most critical bugs cause the dashboard to stop updating when agents join/leave (broken change detection), jump selection unexpectedly on tree rebuilds (index-based tracking), and corrupt the visual layout (shortcut bar overwrites box borders).

## Bug Inventory

| # | File | Bug | Impact |
|---|------|-----|--------|
| 1 | `state-reader.ts:173` | Polls `SELECT MAX(id) FROM messages` — misses agent registrations, room changes, topic updates | Dashboard freezes until a message is sent |
| 2 | `render.ts:194` | Shortcut bar `moveTo(size.rows-1,0)` overwrites bottom border of all 3 boxes | Visual corruption every frame |
| 3 | `tree.ts:77-88` | `selectedIndex` is a raw numeric offset — tree rebuilds reorder nodes, so same index points to different agent | Selection jumps to wrong agent on any state change |
| 4 | `render.ts:200` | `!selectedAgent` shows "No agent selected" even when an agent IS selected (tree/state brief desync) | Confusing blank details panel |
| 5 | `tree.ts:43-56` | Agents shown only under `rooms[0]` (primary room); room member count excludes cross-room members | Room "(1)" when 3 agents are actually there |
| 6 | `app.ts:60`, `state-reader.ts:141`, `status.ts:73` | `catch {}` everywhere — errors are completely invisible | Debugging impossible |
| 7 | `tree.ts:44` | Agents with no rooms are never rendered | Newly registered agents invisible until they join a room |

## UX Enhancement Inventory

| Enhancement | Description |
|-------------|-------------|
| A — Live pane output | Details panel shows raw `capture-pane` output filling all rows after static agent info — turns "org chart" into live ops console |
| B — Multi-room display | Agents appear under every room they're in; secondary appearances rendered dim with `◦` hollow dot |
| C — Scrollable feed | **Deferred to v2** — requires focus-state machinery and per-panel key bindings |

---

## Detailed Design

### Bug 1 Fix — State-reader change detection

**Change:** Replace `SELECT MAX(id) AS max_id FROM messages` with `PRAGMA data_version`.

`data_version` is a WAL-mode counter that increments on every committed write from any connection — agents, rooms, members, messages, cursors, topics. A single query catches everything. `MAX(id)` needs 4 separate queries and misses `UPDATE` operations (rowid unchanged on topic/pane updates).

False positives (e.g. cursor advances triggering re-reads) are acceptable — they just cause one extra `readAll()` at 500ms cadence.

```ts
// Before:
const row = this.db.query('SELECT MAX(id) as max FROM messages').get() as { max: number | null };
const maxId = row?.max ?? 0;
if (maxId !== this.lastMaxId) { ... }

// After:
const row = this.db.query('PRAGMA data_version').get() as { data_version: number };
const v = row.data_version;
if (v !== this.lastVersion) { ... }
```

### Bug 2 Fix — Shortcut bar layout

**Change:** Reduce the `topH` box and `bottomH` box each by 1 row to reserve `size.rows - 1` for the shortcut bar outside all boxes. The left tree box also shrinks by 1.

```ts
// Before:
const topH = Math.max(5, Math.floor(size.rows * 0.65));
const bottomH = size.rows - topH;
buf += drawBox(leftW, topH, rightW, bottomH, 'Details');
buf += moveTo(size.rows - 1, 0) + shortcutBar;

// After:
const usableRows = size.rows - 1;  // last row reserved for shortcut bar
const topH = Math.max(5, Math.floor(usableRows * 0.65));
const bottomH = usableRows - topH;
buf += drawBox(0, 0, leftW, usableRows, 'Rooms & Agents');
buf += drawBox(leftW, 0, rightW, topH, msgTitle);
buf += drawBox(leftW, topH, rightW, bottomH, 'Details');
buf += moveTo(size.rows - 1, 0) + shortcutBar;   // outside all boxes
```

### Bug 3 Fix — ID-based selection tracking

**Change:** `TreeState` tracks `selectedId: string` (node's `.id` field) instead of `selectedIndex: number`. On each `build()`, after constructing `nodes`, re-derive `selectedIndex` by finding `selectedId` in the new array.

`TreeNode.id` already exists and is stable: `'room:company'`, `'agent:lead-1'`.

For multi-room (Enhancement B), a secondary appearance gets id `'agent:lead-1:frontend'` so the user can select the same agent in different room contexts.

```ts
// tree.ts
private selectedId: string | null = null;

build(...): void {
  // ...build nodes as before...
  this.nodes = nodes;
  // Restore selection by ID
  if (this.selectedId) {
    const idx = nodes.findIndex(n => n.id === this.selectedId);
    this.selectedIndex = idx >= 0 ? idx : Math.min(this.selectedIndex, nodes.length - 1);
  }
}

moveUp(): void {
  this.autoSelect = false;
  if (this.selectedIndex > 0) {
    this.selectedIndex--;
    this.selectedId = this.nodes[this.selectedIndex]?.id ?? null;
  }
}
// same for moveDown, moveToTop, moveToBottom
```

### Bug 4 Fix — Details panel loading state

**Change:** When tree has an agent node selected but `state.agents[name]` is undefined (brief desync), show a dim `Syncing...` placeholder instead of "No agent selected".

```ts
// In app.ts draw():
const agentName = tree.selectedAgentName;
const agent = agentName ? state.agents[agentName] ?? null : null;
const isSyncing = agentName !== null && agent === null;
// Pass isSyncing to renderFrame
```

### Bug 5 Fix — (Resolved by Enhancement B)

Multi-room display (see Enhancement B) naturally fixes room member counts and hidden cross-room agents.

### Bug 6 Fix — Error logging to file

**Change:** Log errors to `/tmp/cc-tmux/dashboard.log` (not `console.error` — it corrupts the TUI). Show a `[!]` indicator in the shortcut bar when errors have been logged since dashboard start.

```ts
// dashboard/logger.ts
import { appendFileSync } from 'fs';
const LOG = '/tmp/cc-tmux/dashboard.log';
let errorCount = 0;
export function logError(ctx: string, err: unknown): void {
  errorCount++;
  const line = `${new Date().toISOString()} [${ctx}] ${err instanceof Error ? err.message : String(err)}\n`;
  try { appendFileSync(LOG, line); } catch {}
}
export function hasErrors(): boolean { return errorCount > 0; }
```

Replace `catch {}` with `catch (e) { logError('poll', e); }` etc. Shortcut bar shows `[!]` when `hasErrors()`.

### Bug 7 Fix — Unassigned agents section

**Change:** At the end of `tree.build()`, after all rooms are rendered, check for agents with no rooms (or whose rooms are all empty). Add them under an `── Unassigned ──` pseudo-header.

```ts
// After room loop in tree.build():
const unassigned = Object.values(agents).filter(a => a.rooms.length === 0);
if (unassigned.length > 0) {
  nodes.push({ type: 'room', id: 'room:__unassigned__', label: '── Unassigned ──', memberCount: unassigned.length, collapsed: this.collapsedRooms.has('__unassigned__') });
  if (!this.collapsedRooms.has('__unassigned__')) {
    for (const agent of unassigned) {
      nodes.push({ type: 'agent', id: `agent:${agent.name}`, label: agent.name, agentName: agent.name, role: agent.role, status: statuses.get(agent.name)?.status ?? 'unknown' });
    }
  }
}
```

---

### Enhancement A — Live pane output in details panel

**StatusPoller change:** Store full raw pane output string in `AgentStatusEntry`:
```ts
export interface AgentStatusEntry {
  status: AgentStatus;
  lastChange: number;
  rawOutput?: string;   // full capture-pane output, NOT pre-sliced
}
```
Remove `extractSummary()` and `summary` field. The poller doesn't know the available rows — the renderer decides how many lines to show.

**render.ts details panel change:** After 5 lines of static info (name, role+status, rooms, topic, pane+activity), calculate remaining rows and fill with `rawOutput` lines:

```ts
// Static info block (5 lines max):
buf += moveTo(detailRow++, detailCol) + `${COLORS.bold}${agent.name}${COLORS.reset}`;
buf += moveTo(detailRow++, detailCol) + `${sc}${status}${COLORS.reset}  ${COLORS.dim}${agent.role} · ${agent.tmux_target}${COLORS.reset}`;
buf += moveTo(detailRow++, detailCol) + `Rooms: ${agent.rooms.join(', ')}`;
if (roomTopic) buf += moveTo(detailRow++, detailCol) + `Topic: ${truncate(roomTopic, rightW-6)}`;
if (agent.last_activity) buf += moveTo(detailRow++, detailCol) + `Last: ${COLORS.dim}${ago} ago${COLORS.reset}`;

// Pane output fills remaining rows:
const maxPaneRows = (topH + bottomH - 2) - detailRow;  // rows until box bottom border
if (status?.rawOutput && maxPaneRows > 0) {
  const lines = status.rawOutput.split('\n').filter(Boolean).slice(-maxPaneRows);
  buf += moveTo(detailRow++, detailCol) + COLORS.dim + '─ pane ─' + COLORS.reset;
  for (const line of lines) {
    if (detailRow >= topH + bottomH - 1) break;
    buf += moveTo(detailRow++, detailCol) + COLORS.dim + truncate(line, rightW - 4) + COLORS.reset;
  }
}
```

---

### Enhancement B — Multi-room agent display

**tree.ts change:** `build()` emits each agent under every room they're a member of. Secondary appearances (rooms[1..]) get `secondary: true` on the TreeNode. Node ID for secondary appearances encodes both agent and room context: `'agent:lead-1:frontend'`.

```ts
// TreeNode:
export interface TreeNode {
  ...
  secondary?: boolean;   // true if agent is non-primary in this room context
}

// In tree.build(), inside room loop:
for (const memberName of room.members) {
  const agent = agents[memberName];
  if (!agent) continue;
  const isPrimary = agent.rooms[0] === roomName;
  nodes.push({
    type: 'agent',
    id: isPrimary ? `agent:${memberName}` : `agent:${memberName}:${roomName}`,
    label: memberName,
    agentName: memberName,
    role: agent.role,
    status: statuses.get(memberName)?.status ?? 'unknown',
    secondary: !isPrimary,
  });
}
```

**render.ts change:** Secondary nodes get dim name + `◦` hollow dot (vs `●` solid):
```ts
if (node.type === 'agent') {
  const sc = STATUS_COLORS[node.status ?? 'unknown'];
  const dot = node.secondary ? `${COLORS.dim}◦` : `${sc}●`;
  const nameStyle = node.secondary ? COLORS.dim : '';
  line = `   ${dot}${COLORS.reset} ${nameStyle}${node.label}${COLORS.reset}`;
}
```

**Room member counts** become accurate automatically since we now show all room members (not filtered to primary-room-only agents).

---

## Files Changed

| File | Change |
|------|--------|
| `src/dashboard/state-reader.ts` | Bug 1: swap to `PRAGMA data_version` |
| `src/dashboard/render.ts` | Bug 2: usableRows layout; Bug 4: syncing state; Enhancement A: live pane output; Enhancement B: secondary dot style |
| `src/dashboard/tree.ts` | Bug 3: ID-based selection; Bug 7: Unassigned section; Enhancement B: multi-room nodes |
| `src/dashboard/status.ts` | Enhancement A: `rawOutput` field, remove `extractSummary` |
| `src/dashboard/app.ts` | Bug 4: pass `isSyncing`; Bug 6: wrap catches with `logError` |
| `src/dashboard/logger.ts` | Bug 6: new file, error log + indicator |

**Unchanged:** `src/dashboard/feed.ts`, `src/dashboard/terminal.ts`, `src/state/`, all tools.
