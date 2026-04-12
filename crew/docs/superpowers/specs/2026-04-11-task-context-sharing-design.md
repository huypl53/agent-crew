# Task Context Sharing — Design Spec

**Goal:** Enable worker handoff by allowing agents to write structured context on completed tasks and query related tasks before starting new work.

**Decision:** The FUTURE.md question "sharing task list, context? Should we?" is answered: task lists are already shared (via `get_status` and `getTasksForAgent`). We add **structured context sharing** for worker handoff.

## Problem

When a worker completes a task, everything they learned (files explored, debug findings, architectural understanding) dies with their session. The next worker assigned to related work starts cold — re-exploring the same files, rediscovering the same patterns. This wastes tokens and time.

## Approach: Option B — Context Column + Two New Tools

### Schema Change

Add a `context` TEXT column to the `tasks` table. This is separate from the existing `note` field:

- **`note`** — System-level status annotations (e.g., "interrupted by leader", "agent pane died"). Short. Set by system and workers for errors.
- **`context`** — Worker-written structured knowledge for handoff. Multi-paragraph. Set by workers on task completion. Contains: files explored, key findings, decisions made, relevant code patterns.

### New MCP Tools

**1. `get_task_details`** — Returns full task info including context.

```
get_task_details({ task_id: 5 })
→ { id, room, assigned_to, created_by, summary, status, note, context, created_at, updated_at }
```

Any agent can call this (no role restriction). Returns the full task record including the `context` field that `get_status` omits.

**2. `search_tasks`** — Search completed tasks by room, agent, keyword, status.

```
search_tasks({ room: "crew", keyword: "auth", status: "completed", limit: 10 })
→ [{ id, summary, assigned_to, status, context_preview, updated_at }, ...]
```

Uses SQLite LIKE queries on `summary` + `context`. Returns a preview (first 200 chars of context) to avoid overwhelming the response. Workers call `get_task_details` for full context on specific tasks.

Parameters (all optional):
- `room` — filter by room
- `assigned_to` — filter by agent name
- `keyword` — LIKE search on summary + context
- `status` — filter by status (default: "completed")
- `limit` — max results (default: 10)

### update_task Enhancement

Extend `update_task` to accept a `context` field:

```
update_task({ task_id: 5, status: "completed", context: "Explored src/auth/... Found that...", name: "wk-01" })
```

Workers write context when marking a task as completed.

### Worker Skill Guidance

Update the worker skill to teach workers to write good completion context:

```
When completing a task, include context for future workers:
- What files did you explore or modify?
- What key findings or patterns did you discover?
- What decisions did you make and why?
- What would you tell the next person working in this area?
```

### Dashboard Integration

The `useStateReader.ts` already reads the full tasks table. The `context` field will be available in `DashboardState.tasks` automatically (it's included in `SELECT *`). No dashboard code changes needed — the DetailsPanel already shows task info.

## What We're NOT Building

- No transcript sharing (JSONL files are too large and format-dependent)
- No real-time parallel awareness (leader handles coordination)
- No persistent cross-session knowledge base (out of scope)
- No full-text search or embeddings (SQLite LIKE is sufficient for now)

## Files Affected

- **Modify:** `src/state/db.ts` — add `context` column to tasks schema
- **Modify:** `src/shared/types.ts` — add `context` to Task interface
- **Modify:** `src/state/index.ts` — add `getTaskDetails()`, `searchTasks()`, update `updateTaskStatus()` to accept context
- **Create:** `src/tools/get-task-details.ts` — new MCP tool handler
- **Create:** `src/tools/search-tasks.ts` — new MCP tool handler
- **Modify:** `src/tools/update-task.ts` — accept `context` param
- **Modify:** `src/index.ts` — register two new tools, wire handlers
- **Modify:** `test/state.test.ts` — tests for new state functions
- **Modify:** `test/tools.test.ts` — tests for new tools
- **Modify:** `docs/architecture.md` — document context sharing
- **Modify:** `README.md` — update feature list
