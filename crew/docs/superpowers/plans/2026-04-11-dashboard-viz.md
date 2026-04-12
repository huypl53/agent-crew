# Dashboard Visualization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tab-based view switching with Task Board and Timeline views to the crew dashboard.

**Architecture:** task_events table records status transitions. View switching via Tab key. TaskBoard groups tasks by agent/room. TimelineView renders Unicode bar chart per agent.

**Tech Stack:** React Ink, SQLite, TypeScript, Bun test

**Branch:** `feat/dashboard-viz` in `.worktrees/feat-dashboard-viz/`

---

## Chunk 1: Schema + State Layer (Tasks 1-3)

### Task 1: Add task_events table schema + TaskEvent type

**Files:**
- Modify: `src/state/db.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1:** In `src/shared/types.ts`, add TaskEvent interface after the Task interface:

```ts
export interface TaskEvent {
  id: number;
  task_id: number;
  from_status: string | null;
  to_status: string;
  triggered_by: string | null;
  timestamp: string;
}
```

- [ ] **Step 2:** In `src/state/db.ts`, add task_events table creation in `initDb()` after the tasks table:

```sql
CREATE TABLE IF NOT EXISTS task_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  triggered_by TEXT,
  timestamp    TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
```

- [ ] **Step 3:** Run `bun test` — all should pass (new table, no breaking changes).

- [ ] **Step 4:** Commit:
```bash
git add src/state/db.ts src/shared/types.ts
git commit -m "feat: add task_events table schema and TaskEvent type"
```

### Task 2: Add task event recording + state functions (TDD)

**Files:**
- Modify: `src/state/index.ts`
- Modify: `test/state.test.ts`

- [ ] **Step 1:** Add failing tests to `test/state.test.ts`:

```ts
import { recordTaskEvent, getTaskEvents } from '../src/state/index.ts';

describe('task events', () => {
  test('recordTaskEvent stores a transition', () => {
    const task = createTask('test-room', 'wk-01', 'lead-01', null, 'event test task');
    recordTaskEvent(task.id, null, 'sent', 'system');
    const events = getTaskEvents(task.id);
    expect(events.length).toBe(1);
    expect(events[0].from_status).toBeNull();
    expect(events[0].to_status).toBe('sent');
    expect(events[0].triggered_by).toBe('system');
  });

  test('getTaskEvents returns events in order', () => {
    const task = createTask('test-room', 'wk-01', 'lead-01', null, 'multi event task');
    recordTaskEvent(task.id, null, 'sent', 'system');
    recordTaskEvent(task.id, 'sent', 'active', 'wk-01');
    recordTaskEvent(task.id, 'active', 'completed', 'wk-01');
    const events = getTaskEvents(task.id);
    expect(events.length).toBe(3);
    expect(events[0].to_status).toBe('sent');
    expect(events[1].to_status).toBe('active');
    expect(events[2].to_status).toBe('completed');
  });

  test('getAllTaskEvents returns all events', () => {
    const events = getAllTaskEvents();
    expect(Array.isArray(events)).toBe(true);
  });
});
```

- [ ] **Step 2:** Run `bun test test/state.test.ts` — verify FAIL.

- [ ] **Step 3:** Add functions to `src/state/index.ts`:

```ts
export function recordTaskEvent(taskId: number, fromStatus: string | null, toStatus: string, triggeredBy: string | null): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO task_events (task_id, from_status, to_status, triggered_by, timestamp) VALUES (?, ?, ?, ?, ?)').run(taskId, fromStatus, toStatus, triggeredBy, now);
}

export function getTaskEvents(taskId: number): TaskEvent[] {
  const db = getDb();
  return db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id ASC').all(taskId) as TaskEvent[];
}

export function getAllTaskEvents(): TaskEvent[] {
  const db = getDb();
  return db.prepare('SELECT * FROM task_events ORDER BY timestamp ASC').all() as TaskEvent[];
}
```

Import `TaskEvent` from shared/types.ts.

- [ ] **Step 4:** Run `bun test test/state.test.ts` — verify PASS.
- [ ] **Step 5:** Run `bun test` — verify all pass.

- [ ] **Step 6:** Commit:
```bash
git add src/state/index.ts test/state.test.ts
git commit -m "feat: add recordTaskEvent and getTaskEvents state functions"
```

### Task 3: Wire task event recording into updateTaskStatus

**Files:**
- Modify: `src/state/index.ts`
- Modify: `test/state.test.ts`

- [ ] **Step 1:** Add failing test:

```ts
test('updateTaskStatus records a task event', () => {
  const task = createTask('test-room', 'wk-01', 'lead-01', null, 'auto event task');
  updateTaskStatus(task.id, 'active');
  const events = getTaskEvents(task.id);
  expect(events.length).toBeGreaterThanOrEqual(1);
  const activeEvent = events.find(e => e.to_status === 'active');
  expect(activeEvent).toBeTruthy();
});
```

- [ ] **Step 2:** In `updateTaskStatus`, after the UPDATE query succeeds, add:

```ts
// Record the status transition
const previousStatus = /* get from the task before update */ ;
recordTaskEvent(id, previousStatus, status, undefined);
```

Read the current task status BEFORE the update, then record the event after. The `triggered_by` can be left null here — the caller (tool handler) can pass it if needed.

- [ ] **Step 3:** Run `bun test` — verify all pass.

- [ ] **Step 4:** Commit:
```bash
git add src/state/index.ts test/state.test.ts
git commit -m "feat: auto-record task events on status transitions"
```

---

## Chunk 2: View Switching Infrastructure (Tasks 4-5)

### Task 4: Add useViews hook + view state

**Files:**
- Create: `src/dashboard/hooks/useViews.ts`
- Modify: `src/dashboard/App.tsx`

- [ ] **Step 1:** Create `src/dashboard/hooks/useViews.ts`:

```ts
import { useState, useCallback } from 'react';

export type ViewName = 'dashboard' | 'tasks' | 'timeline';

const VIEW_ORDER: ViewName[] = ['dashboard', 'tasks', 'timeline'];

export function useViews() {
  const [currentView, setCurrentView] = useState<ViewName>('dashboard');

  const cycleView = useCallback(() => {
    setCurrentView(prev => {
      const idx = VIEW_ORDER.indexOf(prev);
      return VIEW_ORDER[(idx + 1) % VIEW_ORDER.length];
    });
  }, []);

  return { currentView, cycleView, setCurrentView };
}
```

- [ ] **Step 2:** In `App.tsx`, import and use `useViews`. Add `Tab` key handler to call `cycleView()`. Pass `currentView` to child components.

- [ ] **Step 3:** Run `bun test` — verify all pass.

- [ ] **Step 4:** Commit:
```bash
git add src/dashboard/hooks/useViews.ts src/dashboard/App.tsx
git commit -m "feat: add view switching hook with Tab key cycling"
```

### Task 5: Add view indicator to HeaderStats + render router in App

**Files:**
- Modify: `src/dashboard/components/HeaderStats.tsx`
- Modify: `src/dashboard/App.tsx`
- Modify: `src/dashboard/hooks/useStateReader.ts`

- [ ] **Step 1:** In `useStateReader.ts`, add `taskEvents: TaskEvent[]` to DashboardState. In `readAll()`, query task_events table (with try/catch for missing table like token_usage).

- [ ] **Step 2:** In `HeaderStats.tsx`, accept `currentView: ViewName` prop. Render view tabs in the header:

```tsx
<Text>
  {(['dashboard', 'tasks', 'timeline'] as const).map(v => (
    <Text key={v} color={v === currentView ? 'cyan' : 'gray'} bold={v === currentView}>
      {` [${v === 'dashboard' ? 'Dashboard' : v === 'tasks' ? 'Tasks' : 'Timeline'}] `}
    </Text>
  ))}
  <Text dimColor> Tab to switch</Text>
</Text>
```

- [ ] **Step 3:** In `App.tsx`, implement the render router for the right panel:

```tsx
{currentView === 'dashboard' && (
  <>
    <MessageFeed ... />
    <DetailsPanel ... />
  </>
)}
{currentView === 'tasks' && (
  <TaskBoard tasks={state.tasks} taskEvents={state.taskEvents} agents={state.agents} ... />
)}
{currentView === 'timeline' && (
  <TimelineView tasks={state.tasks} taskEvents={state.taskEvents} agents={state.agents} ... />
)}
```

For now, TaskBoard and TimelineView can be placeholder components that render "Coming soon".

- [ ] **Step 4:** Create placeholder `src/dashboard/components/TaskBoard.tsx`:
```tsx
import React from 'react';
import { Box, Text } from 'ink';
export function TaskBoard() {
  return <Box><Text>Task Board — coming soon</Text></Box>;
}
```

- [ ] **Step 5:** Create placeholder `src/dashboard/components/TimelineView.tsx`:
```tsx
import React from 'react';
import { Box, Text } from 'ink';
export function TimelineView() {
  return <Box><Text>Timeline — coming soon</Text></Box>;
}
```

- [ ] **Step 6:** Run `bun test` — verify all pass.

- [ ] **Step 7:** Commit:
```bash
git add src/dashboard/components/HeaderStats.tsx src/dashboard/App.tsx src/dashboard/hooks/useStateReader.ts src/dashboard/components/TaskBoard.tsx src/dashboard/components/TimelineView.tsx
git commit -m "feat: add view switching with Tab key and view indicator"
```

---

## Chunk 3: Task Board View (Tasks 6-8)

### Task 6: TaskBoard component — grouped task list

**Files:**
- Modify: `src/dashboard/components/TaskBoard.tsx`

- [ ] **Step 1:** Replace placeholder with full implementation:

Props: `tasks: Task[], taskEvents: TaskEvent[], agents: Agent[], height: number, width: number`

State: `groupBy: 'agent' | 'room'` (toggle with `r` key), `selectedIndex: number` (j/k navigation)

Render: Group tasks by agent or room. For each group, show header with agent/room name. For each task:
```
  #12 ● completed  wk-03  Fix auth middleware  (2m 34s)  JWT tokens expire...
```
- Status colored: green=completed, yellow=active, red=error, cyan=queued
- Duration calculated from task_events (created→completed time)
- Context preview: first 80 chars of context field

- [ ] **Step 2:** Add `r` key handler for toggling groupBy.
- [ ] **Step 3:** Add j/k scrolling for task selection.

- [ ] **Step 4:** Run `bun test` — verify all pass.

- [ ] **Step 5:** Commit:
```bash
git add src/dashboard/components/TaskBoard.tsx
git commit -m "feat: implement TaskBoard view with agent/room grouping"
```

### Task 7: TaskBoard — expanded task details

**Files:**
- Modify: `src/dashboard/components/TaskBoard.tsx`

- [ ] **Step 1:** Add Enter key handler — when pressed on a selected task, expand to show:
- Full summary
- Full context (if present)
- Status history from task_events (timestamps + transitions)
- Duration breakdown per status

- [ ] **Step 2:** Press Enter again or Escape to collapse.

- [ ] **Step 3:** Run `bun test` — verify all pass.

- [ ] **Step 4:** Commit:
```bash
git add src/dashboard/components/TaskBoard.tsx
git commit -m "feat: add expandable task details in TaskBoard"
```

### Task 8: Wire TaskBoard into App with proper props

**Files:**
- Modify: `src/dashboard/App.tsx`

- [ ] **Step 1:** Pass all required props to TaskBoard: tasks, taskEvents, agents, height, width. Forward keyboard events when in tasks view.

- [ ] **Step 2:** Run `bun test` — verify all pass.

- [ ] **Step 3:** Commit:
```bash
git add src/dashboard/App.tsx
git commit -m "feat: wire TaskBoard into App with full props"
```

---

## Chunk 4: Timeline View (Tasks 9-11)

### Task 9: TimelineView component — horizontal bar chart

**Files:**
- Modify: `src/dashboard/components/TimelineView.tsx`

- [ ] **Step 1:** Replace placeholder with full implementation.

Props: `tasks: Task[], taskEvents: TaskEvent[], agents: Agent[], height: number, width: number`

Render:
- Header row: time axis labels
- One row per agent: agent name (left, 12 chars), then horizontal bar segments
- Bar characters: `░` queued, `▓` active, `█` completed, `▒` error
- Colors: yellow=active, green=completed, red=error, magenta=interrupted
- Time axis: calculate min/max timestamps from task_events, divide width into time buckets

Algorithm:
1. Get all task_events, find global time range
2. For each agent, get their tasks and events
3. Map each task's status periods onto the time axis columns
4. Render using Unicode block chars with Ink Text color

- [ ] **Step 2:** Add time axis at bottom showing relative timestamps.

- [ ] **Step 3:** Run `bun test` — verify all pass.

- [ ] **Step 4:** Commit:
```bash
git add src/dashboard/components/TimelineView.tsx
git commit -m "feat: implement Timeline waterfall view with Unicode bars"
```

### Task 10: Timeline zoom + scrolling

**Files:**
- Modify: `src/dashboard/components/TimelineView.tsx`

- [ ] **Step 1:** Add `+`/`-` key handlers for zooming the time axis (wider/narrower time range per column).
- [ ] **Step 2:** Add horizontal scroll if timeline exceeds width.
- [ ] **Step 3:** Add j/k vertical scroll if many agents.

- [ ] **Step 4:** Run `bun test` — verify all pass.

- [ ] **Step 5:** Commit:
```bash
git add src/dashboard/components/TimelineView.tsx
git commit -m "feat: add zoom and scroll to Timeline view"
```

### Task 11: Wire TimelineView into App with proper props

**Files:**
- Modify: `src/dashboard/App.tsx`

- [ ] **Step 1:** Pass all required props to TimelineView. Forward keyboard events when in timeline view.

- [ ] **Step 2:** Run `bun test` — verify all pass.

- [ ] **Step 3:** Commit:
```bash
git add src/dashboard/App.tsx
git commit -m "feat: wire TimelineView into App with full props"
```

---

## Chunk 5: Docs + Verification (Tasks 12-13)

### Task 12: Update documentation

**Files:**
- Modify: `docs/architecture.md`
- Modify: `README.md`
- Modify: `FUTURE.md`

- [ ] **Step 1:** Add "Dashboard Views" section to `docs/architecture.md`:
- View switching system (Tab key)
- Task Board: grouping, filtering, expanded details
- Timeline: waterfall chart, Unicode bars, color coding
- task_events table and recording

- [ ] **Step 2:** Update `README.md` with new dashboard features.

- [ ] **Step 3:** Mark FUTURE.md tasks 3+4 as done.

- [ ] **Step 4:** Commit:
```bash
git add docs/architecture.md README.md FUTURE.md
git commit -m "docs: add dashboard visualization features to architecture and README"
```

### Task 13: Full test suite verification

- [ ] **Step 1:** Run `bun test` three times consecutively.
- [ ] **Step 2:** Report pass/fail counts for all three runs.
- [ ] **Step 3:** Verify all new files exist and are properly imported.
