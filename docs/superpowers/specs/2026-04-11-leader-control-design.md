# Leader/Boss Worker Control & Task Tracking

**Date:** 2026-04-11
**Status:** Draft

## Problem

Leaders and bosses have no way to control workers beyond sending messages. When a worker hangs on a long-running command or receives the wrong task, the leader is powerless. There is also no task-level tracking — only agent-level status (idle/busy/dead) via pane inspection.

Additionally, when multiple sources send messages to the same worker pane simultaneously, deliveries can collide or get lost because there is no coordination of tmux output.

## Goals

1. Give leaders/bosses the ability to interrupt hanging workers and replace queued/active tasks
2. Track task lifecycle (sent → queued → active → completed/error/interrupted/cancelled)
3. Serialize all tmux pane output through a per-pane delivery queue with readiness polling
4. Introduce role-based access control for the new control tools

## Non-Goals

- Changing the existing push/pull messaging model
- Modifying existing tools' role-agnostic behavior
- Task priorities, dependencies, or retry logic
- Worker heartbeat/auto-detection of hangs (but dead agent tasks are cleaned up — see below)
- Dashboard changes (existing `useTaskTracker` heuristic remains; may be migrated to `tasks` table later)

---

## Database Schema

### New `tasks` Table

```sql
CREATE TABLE tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room        TEXT NOT NULL,
  assigned_to TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  message_id  INTEGER,
  summary     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'sent',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_tasks_assigned ON tasks(assigned_to, status);
CREATE INDEX idx_tasks_room     ON tasks(room, status);
```

**Note:** No foreign key constraints on `assigned_to`/`created_by` — matches the `messages` table pattern. This preserves task history when agents leave or are removed.

### Task Status Lifecycle

```
sent → queued         (worker reports: busy, task is in queue)
sent → active         (worker picks it up immediately)
queued → active       (worker starts working on it)
queued → cancelled    (leader used reassign_task to replace it)
active → completed    (worker finished successfully)
active → error        (worker hit an error)
active → interrupted  (leader used interrupt_worker)
interrupted → active  (same task resumed by worker after interruption)
*→ error              (agent detected dead — validateLiveness() cleanup)
```

**Dead agent cleanup:** When `validateLiveness()` detects a dead agent, all their `sent`/`queued`/`active` tasks transition to `error` with note "agent pane died".

`*` = applies to `sent`, `queued`, `active`, and `interrupted` statuses.

---

## New MCP Tools

### 1. `update_task` — Worker Only

```typescript
update_task({
  task_id: number,
  status: "queued" | "active" | "completed" | "error",
  note?: string
})
```

- Role enforcement: caller must be a worker AND the assigned worker for this task
- Used by workers to report task lifecycle transitions
- Returns: `{ updated: true, task_id, status }`

### 2. `interrupt_worker` — Leader/Boss Only

```typescript
interrupt_worker({
  worker_name: string,
  room: string,
  name: string          // caller
})
```

- Role enforcement: caller must be leader or boss
- Validates worker is in the same room
- Checks worker's current task status:
  - If **active** → enqueues `Escape` to pane queue (priority), marks task `interrupted`, sends system notification to worker: `[system@room]: Your current task was interrupted by {caller}`
  - If **no active task** → returns error
- Returns: `{ interrupted: true, task_id, previous_status }`

### 3. `reassign_task` — Leader/Boss Only

```typescript
reassign_task({
  worker_name: string,
  room: string,
  text: string,         // new task content
  name: string          // caller
})
```

- Role enforcement: caller must be leader or boss
- Validates worker is in the same room
- Checks worker's current state:
  - **queued** task → enqueues `ctrl-l` then `paste` (clear input + new text). Old task → `cancelled`, new task → `sent`
  - **active** task → enqueues `escape` then `paste` (interrupt + new text). Old task → `interrupted`, new task → `sent`
  - **idle** (no task) → enqueues `paste` (same as send_message). New task → `sent`
- **Note:** `Ctrl-L` clears the input buffer without interrupting the agent (safe for queued tasks). `Escape` interrupts the running operation (needed for active tasks).
- Returns: `{ reassigned: true, old_task_id?, new_task_id }`

---

## Existing Tool Changes

### `send_message`

When `kind: "task"`:
- **Requires `to` param** — broadcast tasks are not supported (returns error if `to` is omitted)
- Automatically creates a row in the `tasks` table with status `sent`
- Links to the message via `message_id`
- Stores first ~200 chars of text as `summary`
- Returns `task_id` in the response alongside existing fields
- Push delivery now goes through the per-pane queue instead of calling `sendKeys` directly

### `get_status`

Enhanced response includes task information:

```json
{
  "status": "busy",
  "role": "worker",
  "current_task": { "id": 7, "status": "active", "summary": "Build login form..." },
  "queued_tasks": [{ "id": 8, "status": "queued", "summary": "Add validation..." }]
}
```

---

## Role Enforcement

### `assertRole` Guard

```typescript
// src/shared/role-guard.ts
function assertRole(
  callerName: string,
  allowedRoles: AgentRole[],
  action: string
): Agent
```

- Looks up caller in `agents` table
- Throws descriptive error if role is not in `allowedRoles`
  - e.g., `"Only leader/boss can interrupt_worker. You are registered as worker."`
- Returns agent record on success

### Applied To

| Tool | Allowed Roles |
|------|--------------|
| `interrupt_worker` | leader, boss |
| `reassign_task` | leader, boss |
| `update_task` | worker (+ must be assigned worker) |

Existing tools remain role-agnostic.

---

## Per-Pane Delivery Queue

### Architecture

```
send_message (push)  ──┐
interrupt_worker    ────┤
reassign_task       ────┤
                        ▼
              ┌─────────────────┐
              │  Pane Queue     │  (one per tmux target)
              │  %5: [item, ...]│
              │  %8: [item, ...]│
              └────────┬────────┘
                       ▼
              ┌─────────────────┐
              │  Delivery Loop  │  (per pane)
              │  1. Poll: ready?│
              │  2. Send keys   │
              │  3. Next item   │
              └─────────────────┘
```

### Queue Item Types

```typescript
type QueueItem =
  | { type: "paste", text: string, resolve: Function }
  | { type: "escape", resolve: Function }
  | { type: "clear", resolve: Function }           // Ctrl-L to clear input without interrupting
```

### Delivery Loop

```typescript
// src/delivery/pane-queue.ts
class PaneQueue {
  private queue: QueueItem[] = [];
  private processing = false;
  private target: string;

  async enqueue(item: QueueItem): Promise<void> {
    // escape items jump to front of queue
    if (item.type === "escape") {
      this.queue.unshift(item);
    } else {
      this.queue.push(item);
    }
    if (!this.processing) this.process();
  }

  private async process(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      // escape items skip readiness check — must fire immediately
      if (item.type !== "escape") {
        await this.waitForReady();
      }
      await this.deliver(item);
      item.resolve();
    }
    this.processing = false;
  }

  private async waitForReady(): Promise<void> {
    // Poll capturePane() looking for idle prompt indicators
    // Uses existing status-patterns.ts regex
    // Timeout after MAX_WAIT_MS (~10s), deliver anyway (best effort)
  }

  private async deliver(item: QueueItem): Promise<void> {
    switch (item.type) {
      case "paste":
        await sendKeys(this.target, item.text);
        break;
      case "escape":
        await sendEscape(this.target);
        break;
      case "clear":
        await sendClear(this.target);
        break;
    }
  }
}
```

### Cross-Process Serialization

Each Claude Code session spawns its own MCP server subprocess. Multiple MCP processes targeting the same pane would each have independent in-memory queues, defeating serialization. Solution: use a **per-pane file lock** (`/tmp/crew/locks/{pane_id}.lock`) acquired before each delivery and released after. The in-memory queue serializes within a process; the file lock serializes across processes.

### Per-Pane tmux Buffer Names

The existing `sendKeys()` uses a hardcoded buffer name `_crew`. With concurrent pane queues, this causes buffer collisions. Solution: use per-pane buffer names: `_crew_{pane_id}` (e.g., `_crew_%5`).

### Singleton Management

One `PaneQueue` instance per tmux target, stored in a module-level `Map<string, PaneQueue>`. Created on first use, reused thereafter.

---

## tmux Changes

### New Keystroke Primitive

```typescript
// src/tmux/index.ts

// Send Escape to interrupt current operation
export async function sendEscape(target: string): Promise<void> {
  await run('send-keys', '-t', target, 'Escape');
  await Bun.sleep(PASTE_SETTLE_MS);
}

// Send Ctrl-L to clear input buffer without interrupting the agent
export async function sendClear(target: string): Promise<void> {
  await run('send-keys', '-t', target, 'C-l');
  await Bun.sleep(PASTE_SETTLE_MS);
}
```

### Per-Pane Buffer Names

Update existing `sendKeys()` to use per-pane buffer names:

```typescript
// Before: hardcoded '_crew' buffer (collision risk across panes)
const bufferName = '_crew';

// After: per-pane buffer name
const bufferName = `_crew_${target.replace('%', '')}`;
```

---

## Skill Updates

### Worker Skill

- Must call `update_task` at lifecycle transitions:
  - On receiving a task while busy → `update_task(id, "queued")`
  - On starting a task → `update_task(id, "active")`
  - On finishing → `update_task(id, "completed")` or `update_task(id, "error")`
- After being interrupted (Escape received), check `read_messages` for new instructions

### Leader Skill

- New tools: `interrupt_worker`, `reassign_task`
- `get_status` now shows task info — use to decide between interrupt vs reassign
- Decision guide:
  - Worker hanging → `interrupt_worker`, then send new instructions
  - Wrong task queued → `reassign_task` with corrected text
  - Worker idle → normal `send_message`

### Boss Skill

- Same new tools available for escalation scenarios
- Enhanced monitoring via `get_status` with task-level visibility across rooms

---

## Test Plan

### Unit Tests (`test/state.test.ts`)
- Task CRUD: create, read, update status transitions
- Invalid status transitions rejected
- Dead agent cleanup transitions tasks to error

### Unit Tests (`test/role-guard.test.ts`)
- `assertRole` allows correct roles
- `assertRole` rejects wrong roles with descriptive error
- `assertRole` rejects unknown agents

### Tool Tests (`test/tools.test.ts`)
- `update_task`: worker can update own task, cannot update others', non-worker rejected
- `interrupt_worker`: leader can interrupt, worker cannot, no-active-task error
- `reassign_task`: leader can reassign queued/active/idle, worker rejected
- `send_message` with `kind: "task"` creates task record, requires `to` param

### UAT (`test/uat-interrupt.ts`)
- Interrupt a busy Claude Code worker via Escape
- Reassign a queued task on a busy worker
- Verify task status transitions end-to-end

---

## File Changes Summary

| File | Change |
|------|--------|
| `src/state/db.ts` | Add `tasks` table creation |
| `src/state/index.ts` | Add task CRUD functions |
| `src/shared/role-guard.ts` | New file — `assertRole` guard |
| `src/shared/types.ts` | Add `TaskStatus`, `Task` types |
| `src/delivery/pane-queue.ts` | New file — per-pane delivery queue |
| `src/delivery/index.ts` | Route push deliveries through pane queue |
| `src/tmux/index.ts` | Add `sendEscape`, per-pane buffer names |
| `src/tools/update-task.ts` | New tool handler |
| `src/tools/interrupt-worker.ts` | New tool handler |
| `src/tools/reassign-task.ts` | New tool handler |
| `src/tools/send-message.ts` | Auto-create task record when `kind: "task"`, require `to` |
| `src/tools/get-status.ts` | Include task info in response |
| `src/index.ts` | Register 3 new tools |
| `skills/worker/SKILL.md` | Add `update_task` protocol |
| `skills/leader/SKILL.md` | Add interrupt/reassign guidance |
| `skills/boss/SKILL.md` | Add interrupt/reassign guidance |
| `test/role-guard.test.ts` | New — role guard unit tests |
| `test/tools.test.ts` | Add tests for new tools |
| `test/uat-interrupt.ts` | New — UAT for interrupt/reassign |
