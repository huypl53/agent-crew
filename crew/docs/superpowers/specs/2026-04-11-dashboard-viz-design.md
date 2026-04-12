# Dashboard Visualization — Design Spec

**Goal:** Add tab-based view switching to the dashboard with a Task Board view and a Timeline (waterfall) view, enabling detailed task inspection and visual tracing of task execution across agents.

**Combines FUTURE.md Tasks 3+4:**
- "dashboard enhance for waterfall tracing tasks, session of agents"
- "in dashboard, I want to have the ability to see the details tasks, tasks of each agent"

## Approach: Tab-Based View System

### Schema Change — task_events table

Add a `task_events` table to record every status transition with timestamps:

```sql
CREATE TABLE IF NOT EXISTS task_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  triggered_by TEXT,
  timestamp   TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
```

Record events on every `updateTaskStatus` call. This enables accurate timeline reconstruction.

### View System

Three views, switchable with `Tab` key. Current view shown in header.

**View 1 — Dashboard (default):** Current layout unchanged. MessageFeed + DetailsPanel.

**View 2 — Task Board:** All tasks in a scrollable list, grouped by agent or room (toggle with `r` key).
- Columns: ID, Status (colored), Agent, Summary (truncated), Duration, Context preview (first 80 chars)
- Sortable by most recent first
- j/k to scroll, Enter to expand full task details inline

**View 3 — Timeline:** Horizontal bar chart of task execution per agent.
- Each agent gets a row
- Tasks rendered as Unicode block character bars (▓ active, █ completed, ░ queued, ▒ error)
- Color-coded: yellow=active, green=completed, red=error, magenta=interrupted
- Time axis at bottom showing relative time
- Scrollable if many agents

### Layout

All three views share:
- **Header (HeaderStats):** Same as now, plus view indicator `[Dashboard] [Tasks] [Timeline]`
- **Left panel (TreePanel):** Always visible, same as now
- **Right panel:** Switches between MessageFeed+DetailsPanel (View 1), TaskBoard (View 2), Timeline (View 3)

### Keyboard

- `Tab` — cycle views (1→2→3→1)
- Existing keys (j/k, 1-6 filters, ?, q) still work
- View 2 adds: `r` toggle group-by (agent/room), Enter expand task
- View 3 adds: `+`/`-` zoom time axis

## Files Affected

### New files
- `src/dashboard/components/TaskBoard.tsx` — Task Board view component
- `src/dashboard/components/TimelineView.tsx` — Timeline/waterfall view component
- `src/dashboard/hooks/useViews.ts` — View state management hook

### Modified files
- `src/state/db.ts` — add task_events table
- `src/state/index.ts` — add recordTaskEvent(), getTaskEvents(), update updateTaskStatus to record events
- `src/shared/types.ts` — add TaskEvent interface
- `src/dashboard/App.tsx` — add view switching, render router
- `src/dashboard/components/HeaderStats.tsx` — add view indicator
- `src/dashboard/hooks/useStateReader.ts` — add taskEvents to DashboardState
- `test/state.test.ts` — tests for task events
- `docs/architecture.md` — document new views
- `README.md` — update feature list
- `FUTURE.md` — mark tasks 3+4 done

## What We're NOT Building

- No mouse support (TUI only)
- No configurable/resizable panels
- No real-time animation (poll-based updates like existing dashboard)
- No export/screenshot of timeline
- No embedding-based task search
