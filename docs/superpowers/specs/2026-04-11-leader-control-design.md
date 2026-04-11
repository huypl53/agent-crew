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
- Worker heartbeat/auto-detection of hangs

---

## Database Schema

### New `tasks` Table

```sql
CREATE TABLE tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room        TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
  assigned_to TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
  created_by  TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
  message_id  INTEGER REFERENCES messages(id),
  summary     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'sent',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_tasks_assigned ON tasks(assigned_to, status);
CREATE INDEX idx_tasks_room     ON tasks(room, status);
```

### Task Status Lifecycle

```
sent → queued         (worker reports: busy, task is in queue)
sent → active         (worker picks it up immediately)
queued → active       (worker starts working on it)
queued → cancelled    (leader used reassign_task to replace it)
active → completed    (worker finished successfully)
active → error        (worker hit an error)
active → interrupted  (leader used interrupt_worker)
interrupted → active  (worker resumes or gets new instruction)
```

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
  - If **active** → enqueues `Escape` to pane queue (priority), marks task `interrupted`
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
  - **queued** task → enqueues `clear_and_paste` (Up + Esc Esc + new text). Old task → `cancelled`, new task → `sent`
  - **active** task → enqueues `escape` then `paste` (Esc + new text). Old task → `interrupted`, new task → `sent`
  - **idle** (no task) → enqueues `paste` (same as send_message). New task → `sent`
- Returns: `{ reassigned: true, old_task_id?, new_task_id }`

---

## Existing Tool Changes

### `send_message`

When `kind: "task"`:
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
  | { type: "clear_and_paste", text: string, resolve: Function }
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
      case "clear_and_paste":
        await clearQueuedInput(this.target);
        await sendKeys(this.target, item.text);
        break;
    }
  }
}
```

### Singleton Management

One `PaneQueue` instance per tmux target, stored in a module-level `Map<string, PaneQueue>`. Created on first use, reused thereafter.

---

## tmux Keystroke Primitives

New functions in `src/tmux/index.ts`:

```typescript
// Send Escape to interrupt current operation
async function sendEscape(target: string): Promise<void> {
  await run('send-keys', '-t', target, 'Escape');
  await Bun.sleep(PASTE_SETTLE_MS);
}

// Clear queued input: Up to recall, double Escape to clear
async function clearQueuedInput(target: string): Promise<void> {
  await run('send-keys', '-t', target, 'Up');
  await Bun.sleep(PASTE_SETTLE_MS);
  await run('send-keys', '-t', target, 'Escape');
  await Bun.sleep(100);
  await run('send-keys', '-t', target, 'Escape');
  await Bun.sleep(PASTE_SETTLE_MS);
}
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

## File Changes Summary

| File | Change |
|------|--------|
| `src/state/db.ts` | Add `tasks` table creation |
| `src/state/index.ts` | Add task CRUD functions |
| `src/shared/role-guard.ts` | New file — `assertRole` guard |
| `src/shared/types.ts` | Add `TaskStatus`, `Task` types |
| `src/delivery/pane-queue.ts` | New file — per-pane delivery queue |
| `src/delivery/index.ts` | Route push deliveries through pane queue |
| `src/tmux/index.ts` | Add `sendEscape`, `clearQueuedInput` |
| `src/tools/update-task.ts` | New tool handler |
| `src/tools/interrupt-worker.ts` | New tool handler |
| `src/tools/reassign-task.ts` | New tool handler |
| `src/tools/send-message.ts` | Auto-create task record when `kind: "task"` |
| `src/tools/get-status.ts` | Include task info in response |
| `src/index.ts` | Register 3 new tools |
| `skills/worker/SKILL.md` | Add `update_task` protocol |
| `skills/leader/SKILL.md` | Add interrupt/reassign guidance |
| `skills/boss/SKILL.md` | Add interrupt/reassign guidance |
