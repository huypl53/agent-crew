# Leader/Boss Worker Control & Task Tracking — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give leaders/bosses the ability to interrupt workers and replace tasks, backed by a task lifecycle table, per-pane delivery queue, and role enforcement.

**Architecture:** New `tasks` SQLite table tracks task lifecycle. Three new MCP tools (`update_task`, `interrupt_worker`, `reassign_task`) with role-based access control. All tmux output routed through a per-pane delivery queue with readiness polling and cross-process file locks. Dashboard upgraded to read authoritative task status from DB.

**Tech Stack:** Bun, TypeScript, SQLite (WAL), tmux, MCP SDK, Ink/React (dashboard)

**Spec:** `docs/superpowers/specs/2026-04-11-leader-control-design.md`

---

## Chunk 1: Foundation (Types, Schema, State CRUD)

### Task 1: Add Task Types

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Write failing test — TaskStatus type exists**

In `test/tools.test.ts`, add at top (after existing imports):

```typescript
import type { TaskStatus, Task } from '../src/shared/types.ts';
```

Run: `bun test test/tools.test.ts`
Expected: FAIL — `TaskStatus` and `Task` not exported

- [ ] **Step 2: Add types to `src/shared/types.ts`**

Add after the `Message` interface (line 33):

```typescript
export type TaskStatus = 'sent' | 'queued' | 'active' | 'completed' | 'error' | 'interrupted' | 'cancelled';

export interface Task {
  id: number;
  room: string;
  assigned_to: string;
  created_by: string;
  message_id: number | null;
  summary: string;
  status: TaskStatus;
  note?: string;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 3: Run test to verify import succeeds**

Run: `bun test test/tools.test.ts`
Expected: PASS — all existing tests still pass

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts test/tools.test.ts
git commit -m "feat: add TaskStatus and Task types"
```

---

### Task 2: Add Tasks Table to Schema

**Files:**
- Modify: `src/state/db.ts`

- [ ] **Step 1: Add tasks table to SCHEMA constant**

In `src/state/db.ts`, add after the `cursors` table definition (line 49), before the indexes:

```sql
  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    room        TEXT NOT NULL,
    assigned_to TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    message_id  INTEGER,
    summary     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'sent',
    note        TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status);
  CREATE INDEX IF NOT EXISTS idx_tasks_room     ON tasks(room, status);
```

- [ ] **Step 2: Run existing tests to verify schema migration**

Run: `bun test`
Expected: All existing tests PASS — the new table is additive

- [ ] **Step 3: Commit**

```bash
git add src/state/db.ts
git commit -m "feat: add tasks table to SQLite schema"
```

---

### Task 3: Add Task CRUD Functions to State

**Files:**
- Modify: `src/state/index.ts`
- Create: `test/state.test.ts`

- [ ] **Step 1: Write failing tests for task CRUD**

Create `test/state.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { initDb, closeDb } from '../src/state/db.ts';
import {
  addAgent, clearState, getAgent,
} from '../src/state/index.ts';

// These imports will fail until we implement them
import {
  createTask, getTask, getTasksForAgent, updateTaskStatus, cleanupDeadAgentTasks,
} from '../src/state/index.ts';

describe('Task CRUD', () => {
  beforeEach(() => {
    initDb(':memory:');
    clearState();
    // Set up agents in rooms for task tests
    addAgent('lead-1', 'leader', 'frontend', '%1');
    addAgent('worker-1', 'worker', 'frontend', '%2');
  });

  afterAll(() => { closeDb(); });

  test('createTask creates a task with status sent', () => {
    const task = createTask('frontend', 'worker-1', 'lead-1', 1, 'Build login form');
    expect(task.id).toBeGreaterThan(0);
    expect(task.status).toBe('sent');
    expect(task.assigned_to).toBe('worker-1');
    expect(task.created_by).toBe('lead-1');
    expect(task.summary).toBe('Build login form');
    expect(task.room).toBe('frontend');
    expect(task.message_id).toBe(1);
  });

  test('getTask retrieves task by id', () => {
    const created = createTask('frontend', 'worker-1', 'lead-1', null, 'Test task');
    const fetched = getTask(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.summary).toBe('Test task');
  });

  test('getTask returns undefined for non-existent id', () => {
    expect(getTask(999)).toBeUndefined();
  });

  test('getTasksForAgent returns tasks by status', () => {
    createTask('frontend', 'worker-1', 'lead-1', null, 'Task A');
    createTask('frontend', 'worker-1', 'lead-1', null, 'Task B');
    const tasks = getTasksForAgent('worker-1');
    expect(tasks.length).toBe(2);
  });

  test('getTasksForAgent filters by status', () => {
    const t1 = createTask('frontend', 'worker-1', 'lead-1', null, 'Task A');
    createTask('frontend', 'worker-1', 'lead-1', null, 'Task B');
    updateTaskStatus(t1.id, 'active');
    const active = getTasksForAgent('worker-1', ['active']);
    expect(active.length).toBe(1);
    expect(active[0]!.status).toBe('active');
  });

  test('updateTaskStatus transitions valid states', () => {
    const task = createTask('frontend', 'worker-1', 'lead-1', null, 'Task');
    // sent → active
    const updated = updateTaskStatus(task.id, 'active');
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('active');
    // active → completed
    const done = updateTaskStatus(task.id, 'completed');
    expect(done!.status).toBe('completed');
  });

  test('updateTaskStatus stores note', () => {
    const task = createTask('frontend', 'worker-1', 'lead-1', null, 'Task');
    updateTaskStatus(task.id, 'error', 'Something broke');
    const fetched = getTask(task.id);
    expect(fetched!.note).toBe('Something broke');
  });

  test('updateTaskStatus rejects invalid transitions', () => {
    const task = createTask('frontend', 'worker-1', 'lead-1', null, 'Task');
    updateTaskStatus(task.id, 'active');
    updateTaskStatus(task.id, 'completed');
    // completed → active is not valid
    expect(() => updateTaskStatus(task.id, 'active')).toThrow('Invalid transition');
  });

  test('updateTaskStatus returns undefined for non-existent task', () => {
    expect(updateTaskStatus(999, 'active')).toBeUndefined();
  });

  test('cleanupDeadAgentTasks transitions non-terminal tasks to error', () => {
    const t1 = createTask('frontend', 'worker-1', 'lead-1', null, 'Active task');
    updateTaskStatus(t1.id, 'active');
    const t2 = createTask('frontend', 'worker-1', 'lead-1', null, 'Queued task');
    updateTaskStatus(t2.id, 'queued');
    const t3 = createTask('frontend', 'worker-1', 'lead-1', null, 'Completed task');
    updateTaskStatus(t3.id, 'active');
    updateTaskStatus(t3.id, 'completed');

    cleanupDeadAgentTasks('worker-1');

    // Active and queued should be error
    expect(getTask(t1.id)!.status).toBe('error');
    expect(getTask(t1.id)!.note).toBe('agent pane died');
    expect(getTask(t2.id)!.status).toBe('error');
    // Completed should be unchanged
    expect(getTask(t3.id)!.status).toBe('completed');
  });
});
```

Run: `bun test test/state.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 2: Implement task CRUD in `src/state/index.ts`**

Add at the end of the file (before `// --- Test helpers ---`):

```typescript
// --- Task operations ---

import type { Task, TaskStatus } from '../shared/types.ts';

export function createTask(
  room: string,
  assignedTo: string,
  createdBy: string,
  messageId: number | null,
  summary: string,
): Task {
  const db = getDb();
  const ts = now();
  const truncated = summary.length > 200 ? summary.slice(0, 197) + '...' : summary;
  const stmt = db.run(
    'INSERT INTO tasks (room, assigned_to, created_by, message_id, summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [room, assignedTo, createdBy, messageId, truncated, 'sent', ts, ts],
  );
  return getTask(stmt.lastInsertRowid as number)!;
}

export function getTask(id: number): Task | undefined {
  const row = getDb().query('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | null;
  if (!row) return undefined;
  return rowToTask(row);
}

export function getTasksForAgent(agentName: string, statuses?: TaskStatus[]): Task[] {
  const db = getDb();
  let sql = 'SELECT * FROM tasks WHERE assigned_to = ?';
  const params: unknown[] = [agentName];
  if (statuses && statuses.length > 0) {
    sql += ` AND status IN (${statuses.map(() => '?').join(',')})`;
    params.push(...statuses);
  }
  sql += ' ORDER BY id';
  return (db.query(sql).all(...params) as Record<string, unknown>[]).map(rowToTask);
}

const VALID_TRANSITIONS: Record<string, TaskStatus[]> = {
  sent:        ['queued', 'active', 'error'],
  queued:      ['active', 'cancelled', 'error'],
  active:      ['completed', 'error', 'interrupted'],
  interrupted: ['active', 'error'],
};

export function updateTaskStatus(id: number, status: TaskStatus, note?: string): Task | undefined {
  const db = getDb();
  const existing = getTask(id);
  if (!existing) return undefined;

  // Validate transition
  const allowed = VALID_TRANSITIONS[existing.status];
  if (!allowed || !allowed.includes(status)) {
    throw new Error(`Invalid transition: ${existing.status} → ${status}`);
  }

  const ts = now();
  let sql = 'UPDATE tasks SET status = ?, updated_at = ?';
  const params: unknown[] = [status, ts];
  if (note !== undefined) {
    sql += ', note = ?';
    params.push(note);
  }
  sql += ' WHERE id = ?';
  params.push(id);
  db.run(sql, params);
  return getTask(id);
}

/** Bypass transition validation — force-transition all non-terminal tasks to error */
export function cleanupDeadAgentTasks(agentName: string): void {
  const db = getDb();
  const ts = now();
  db.run(
    `UPDATE tasks SET status = 'error', note = 'agent pane died', updated_at = ?
     WHERE assigned_to = ? AND status IN ('sent', 'queued', 'active', 'interrupted')`,
    [ts, agentName],
  );
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as number,
    room: row.room as string,
    assigned_to: row.assigned_to as string,
    created_by: row.created_by as string,
    message_id: row.message_id as number | null,
    summary: row.summary as string,
    status: row.status as TaskStatus,
    note: row.note as string | undefined,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}
```

- [ ] **Step 3: Update `clearState` to include tasks table**

In `src/state/index.ts`, update the `clearState` function:

```typescript
export function clearState(): void {
  const db = getDb();
  db.exec('DELETE FROM tasks; DELETE FROM messages; DELETE FROM cursors; DELETE FROM members; DELETE FROM rooms; DELETE FROM agents;');
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/state.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/state/index.ts test/state.test.ts
git commit -m "feat: add task CRUD operations to state module"
```

---

### Task 4: Integrate Dead Agent Cleanup with Tasks

**Files:**
- Modify: `src/state/index.ts`

- [ ] **Step 1: Write failing test**

Add to `test/state.test.ts`:

```typescript
import { validateLiveness, removeAgentFully } from '../src/state/index.ts';

test('validateLiveness cleans up tasks for dead agents', async () => {
  // This test uses a fake pane that doesn't exist — isPaneDead returns true
  addAgent('dead-worker', 'worker', 'frontend', '%99999');
  const task = createTask('frontend', 'dead-worker', 'lead-1', null, 'Doomed task');
  updateTaskStatus(task.id, 'active');

  await validateLiveness();

  const updated = getTask(task.id);
  expect(updated!.status).toBe('error');
  expect(updated!.note).toBe('agent pane died');
});
```

Run: `bun test test/state.test.ts`
Expected: FAIL — task status not updated (current `validateLiveness` only calls `removeAgentFully`)

- [ ] **Step 2: Update `validateLiveness` to clean up tasks**

In `src/state/index.ts`, modify `validateLiveness`:

```typescript
export async function validateLiveness(): Promise<string[]> {
  const dead: string[] = [];
  for (const agent of getAllAgents()) {
    if (await isPaneDead(agent.tmux_target)) {
      cleanupDeadAgentTasks(agent.name);
      removeAgentFully(agent.name);
      dead.push(agent.name);
    }
  }
  return dead;
}
```

- [ ] **Step 3: Run tests**

Run: `bun test test/state.test.ts`
Expected: PASS

- [ ] **Step 4: Run all tests to verify no regressions**

Run: `bun test`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/state/index.ts test/state.test.ts
git commit -m "feat: clean up tasks when dead agents are removed"
```

---

### Task 5: Add Role Guard

**Files:**
- Create: `src/shared/role-guard.ts`
- Create: `test/role-guard.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/role-guard.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { initDb, closeDb } from '../src/state/db.ts';
import { addAgent, clearState } from '../src/state/index.ts';
import { assertRole } from '../src/shared/role-guard.ts';

describe('assertRole', () => {
  beforeEach(() => {
    initDb(':memory:');
    clearState();
    addAgent('lead-1', 'leader', 'frontend', '%1');
    addAgent('worker-1', 'worker', 'frontend', '%2');
    addAgent('boss-1', 'boss', 'company', '%3');
  });

  afterAll(() => { closeDb(); });

  test('allows leader for leader-allowed action', () => {
    const agent = assertRole('lead-1', ['leader', 'boss'], 'interrupt_worker');
    expect(agent.name).toBe('lead-1');
    expect(agent.role).toBe('leader');
  });

  test('allows boss for leader/boss-allowed action', () => {
    const agent = assertRole('boss-1', ['leader', 'boss'], 'interrupt_worker');
    expect(agent.name).toBe('boss-1');
  });

  test('rejects worker for leader-only action', () => {
    expect(() => assertRole('worker-1', ['leader', 'boss'], 'interrupt_worker'))
      .toThrow('Only leader/boss can interrupt_worker');
  });

  test('rejects unknown agent', () => {
    expect(() => assertRole('nobody', ['leader', 'boss'], 'interrupt_worker'))
      .toThrow('not registered');
  });

  test('allows worker for worker-allowed action', () => {
    const agent = assertRole('worker-1', ['worker'], 'update_task');
    expect(agent.name).toBe('worker-1');
  });
});
```

Run: `bun test test/role-guard.test.ts`
Expected: FAIL — module not found

- [ ] **Step 2: Implement role guard**

Create `src/shared/role-guard.ts`:

```typescript
import type { Agent, AgentRole } from './types.ts';
import { getAgent } from '../state/index.ts';

export function assertRole(
  callerName: string,
  allowedRoles: AgentRole[],
  action: string,
): Agent {
  const agent = getAgent(callerName);
  if (!agent) {
    throw new Error(`Agent "${callerName}" is not registered`);
  }
  if (!allowedRoles.includes(agent.role)) {
    throw new Error(
      `Only ${allowedRoles.join('/')} can ${action}. You are registered as ${agent.role}.`
    );
  }
  return agent;
}
```

- [ ] **Step 3: Run tests**

Run: `bun test test/role-guard.test.ts`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/shared/role-guard.ts test/role-guard.test.ts
git commit -m "feat: add assertRole guard for role-based access control"
```

---

## Chunk 2: tmux Primitives & Per-Pane Delivery Queue

### Task 6: Add tmux Keystroke Primitives

**Files:**
- Modify: `src/tmux/index.ts`

- [ ] **Step 1: Add `sendEscape` and `sendClear` functions**

In `src/tmux/index.ts`, add after the `sendKeys` function (after line 83):

```typescript
export async function sendEscape(target: string): Promise<{ delivered: boolean; error?: string }> {
  try {
    const result = await run('send-keys', '-t', target, 'Escape');
    if (!result.success) {
      return { delivered: false, error: result.stderr || 'send-keys Escape failed' };
    }
    await Bun.sleep(PASTE_SETTLE_MS);
    return { delivered: true };
  } catch {
    return { delivered: false, error: 'Escape delivery failed' };
  }
}

export async function sendClear(target: string): Promise<{ delivered: boolean; error?: string }> {
  try {
    const result = await run('send-keys', '-t', target, 'C-l');
    if (!result.success) {
      return { delivered: false, error: result.stderr || 'send-keys C-l failed' };
    }
    await Bun.sleep(PASTE_SETTLE_MS);
    return { delivered: true };
  } catch {
    return { delivered: false, error: 'Ctrl-L delivery failed' };
  }
}
```

- [ ] **Step 2: Update `sendKeys` to use per-pane buffer names**

In `src/tmux/index.ts`, modify the `sendKeys` function. Change the hardcoded `'_crew'` buffer name (lines 49, 63, 80) to use a per-pane name:

```typescript
// At the top of sendKeys, compute per-pane buffer name:
const bufferName = `_crew_${target.replace('%', '')}`;
```

Then replace all three occurrences of `'_crew'` with `bufferName`:
- Line 49: `load-buffer -b _crew` → `load-buffer -b ${bufferName}`
- Line 63: `paste-buffer -dp -b _crew` → `paste-buffer -dp -b ${bufferName}`
- Line 80: `delete-buffer -b _crew` → `delete-buffer -b ${bufferName}`

- [ ] **Step 3: Run existing tests to verify no regressions**

Run: `bun test`
Expected: All existing tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/tmux/index.ts
git commit -m "feat: add sendEscape, sendClear, per-pane buffer names"
```

---

### Task 7: Build Per-Pane Delivery Queue

**Files:**
- Create: `src/delivery/pane-queue.ts`
- Create: `test/pane-queue.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/pane-queue.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { createTestSession, destroyTestSession, cleanupAllTestSessions, captureFromPane } from './helpers.ts';
import { PaneQueue, getQueue } from '../src/delivery/pane-queue.ts';

let testPane: string;
const SESSION = 'pane-queue-test';

describe('PaneQueue', () => {
  beforeEach(async () => {
    const s = await createTestSession(SESSION);
    testPane = s.pane;
  });

  afterAll(async () => {
    await cleanupAllTestSessions();
  });

  test('getQueue returns same instance for same pane', () => {
    const q1 = getQueue(testPane);
    const q2 = getQueue(testPane);
    expect(q1).toBe(q2);
  });

  test('enqueue paste delivers text to pane', async () => {
    const q = getQueue(testPane);
    await q.enqueue({ type: 'paste', text: 'hello from queue' });
    await Bun.sleep(200);
    const output = await captureFromPane(testPane);
    expect(output).toContain('hello from queue');
  });

  test('enqueue escape delivers Escape to pane', async () => {
    const q = getQueue(testPane);
    // Should not throw
    await q.enqueue({ type: 'escape' });
  });

  test('enqueue clear delivers Ctrl-L to pane', async () => {
    const q = getQueue(testPane);
    // Should not throw
    await q.enqueue({ type: 'clear' });
  });

  test('escape items jump to front of queue', async () => {
    const q = getQueue(testPane);
    const order: string[] = [];
    // Enqueue paste then escape — escape should process first
    const p1 = q.enqueue({ type: 'paste', text: 'first' }).then(() => order.push('paste'));
    const p2 = q.enqueue({ type: 'escape' }).then(() => order.push('escape'));
    await Promise.all([p1, p2]);
    // escape should have been processed before paste
    expect(order[0]).toBe('escape');
  });
});
```

Run: `bun test test/pane-queue.test.ts`
Expected: FAIL — module not found

- [ ] **Step 2: Implement PaneQueue**

Create `src/delivery/pane-queue.ts`:

```typescript
import { sendKeys, sendEscape, sendClear, capturePane } from '../tmux/index.ts';
import { matchStatusLine } from '../shared/status-patterns.ts';
import { existsSync, mkdirSync, openSync, closeSync } from 'fs';
import { flockSync } from 'bun';

export type QueueItem =
  | { type: 'paste'; text: string }
  | { type: 'escape' }
  | { type: 'clear' };

interface QueueEntry {
  item: QueueItem;
  resolve: () => void;
  reject: (err: Error) => void;
}

const MAX_WAIT_MS = 10_000;
const POLL_INTERVAL_MS = 500;
const LOCKS_DIR = '/tmp/crew/locks';

export class PaneQueue {
  private queue: QueueEntry[] = [];
  private processing = false;
  readonly target: string;

  constructor(target: string) {
    this.target = target;
  }

  enqueue(item: QueueItem): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = { item, resolve, reject };
      if (item.type === 'escape') {
        this.queue.unshift(entry);
      } else {
        this.queue.push(entry);
      }
      if (!this.processing) this.process();
    });
  }

  private async process(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      try {
        if (entry.item.type !== 'escape') {
          await this.waitForReady();
        }
        await this.withLock(() => this.deliver(entry.item));
        entry.resolve();
      } catch (err) {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    this.processing = false;
  }

  private async waitForReady(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < MAX_WAIT_MS) {
      const output = await capturePane(this.target);
      if (output !== null) {
        const status = matchStatusLine(output);
        if (status === 'idle') return;
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    // Timeout — deliver anyway (best effort)
  }

  private async deliver(item: QueueItem): Promise<void> {
    switch (item.type) {
      case 'paste':
        await sendKeys(this.target, item.text);
        break;
      case 'escape':
        await sendEscape(this.target);
        break;
      case 'clear':
        await sendClear(this.target);
        break;
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (!existsSync(LOCKS_DIR)) mkdirSync(LOCKS_DIR, { recursive: true });
    const lockPath = `${LOCKS_DIR}/${this.target.replace('%', '')}.lock`;
    const fd = openSync(lockPath, 'w');
    try {
      flockSync(fd, 2); // LOCK_EX
      return await fn();
    } finally {
      flockSync(fd, 8); // LOCK_UN
      closeSync(fd);
    }
  }
}

const queues = new Map<string, PaneQueue>();

export function getQueue(target: string): PaneQueue {
  let q = queues.get(target);
  if (!q) {
    q = new PaneQueue(target);
    queues.set(target, q);
  }
  return q;
}
```

- [ ] **Step 3: Run tests**

Run: `bun test test/pane-queue.test.ts`
Expected: All PASS

Note: If `flockSync` is not available in Bun, fall back to a simpler approach using `Bun.file(lockPath).writer()` or skip the lock in tests. Check Bun docs first.

- [ ] **Step 4: Commit**

```bash
git add src/delivery/pane-queue.ts test/pane-queue.test.ts
git commit -m "feat: add per-pane delivery queue with readiness polling and file locks"
```

---

### Task 8: Route Delivery Through Pane Queue

**Files:**
- Modify: `src/delivery/index.ts`

- [ ] **Step 1: Update `deliverMessage` to use pane queue**

In `src/delivery/index.ts`, replace the direct `sendKeys` call with the pane queue:

```typescript
import { getQueue } from './pane-queue.ts';
```

Replace lines 42-54 (the push delivery block):

```typescript
    if (mode === 'push') {
      const agent = getAgent(to);
      if (agent) {
        try {
          await getQueue(agent.tmux_target).enqueue({ type: 'paste', text: fullText });
          results.push({ message_id: msg.message_id, delivered: true, queued: true });
        } catch (e) {
          results.push({
            message_id: msg.message_id,
            delivered: false,
            queued: true,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      } else {
        results.push({ message_id: msg.message_id, delivered: false, queued: true, error: 'Agent not found' });
      }
    }
```

Also update the auto-notify block (lines 70-72) to use the queue:

```typescript
      for (const leader of leaders) {
        getQueue(leader.tmux_target).enqueue({ type: 'paste', text: notifyText }).catch(() => {});
      }
```

- [ ] **Step 2: Run all tests**

Run: `bun test`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/delivery/index.ts
git commit -m "feat: route all push delivery through per-pane queue"
```

---

## Chunk 3: New MCP Tools

### Task 9: Update `send_message` for Auto Task Creation

**Files:**
- Modify: `src/tools/send-message.ts`
- Modify: `src/delivery/index.ts`

- [ ] **Step 1: Write failing test**

Add to `test/tools.test.ts` in the `messaging` describe block:

```typescript
    test('send_message with kind=task creates task record and returns task_id', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const result = await handleSendMessage({
        room: 'frontend',
        text: 'Build the login page with validation',
        to: 'builder-1',
        name: 'lead-1',
        kind: 'task',
      });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.task_id).toBeDefined();
      expect(data.task_id).toBeGreaterThan(0);
    });

    test('send_message with kind=task requires to param', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const result = await handleSendMessage({
        room: 'frontend',
        text: 'Build something',
        name: 'lead-1',
        kind: 'task',
      });
      expect(result.isError).toBe(true);
    });
```

Run: `bun test test/tools.test.ts`
Expected: FAIL — `task_id` not in response

- [ ] **Step 2: Update `deliverMessage` to return message_id as number**

In `src/delivery/index.ts`, update the `DeliveryResult` interface and function to include `task_id`:

```typescript
interface DeliveryResult {
  message_id: string;
  delivered: boolean;
  queued: boolean;
  error?: string;
  task_id?: number;
}
```

Add `createTask` import and call after `addMessage` when kind is 'task':

```typescript
import { addMessage, getAgent, getRoomMembers, createTask } from '../state/index.ts';
```

After `const msg = addMessage(...)` (line 40), add:

```typescript
    let taskId: number | undefined;
    if (kind === 'task') {
      const task = createTask(room, targetName ?? to, senderName, Number(msg.message_id), text);
      taskId = task.id;
    }
```

Include `task_id: taskId` in each result object.

- [ ] **Step 3: Update `handleSendMessage` to enforce `to` for tasks and return `task_id`**

In `src/tools/send-message.ts`, add validation after the existing checks (line 18):

```typescript
  if (kind === 'task' && !to) {
    return err('Task messages require a "to" param — broadcast tasks are not supported');
  }
```

Update the single-result return (line 50) to include `task_id`:

```typescript
    return ok({
      message_id: results[0]!.message_id,
      delivered: results[0]!.delivered,
      queued: results[0]!.queued,
      ...(results[0]!.task_id !== undefined && { task_id: results[0]!.task_id }),
    });
```

- [ ] **Step 4: Run tests**

Run: `bun test test/tools.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/send-message.ts src/delivery/index.ts test/tools.test.ts
git commit -m "feat: auto-create task record on send_message kind=task"
```

---

### Task 10: Implement `update_task` Tool

**Files:**
- Create: `src/tools/update-task.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/tools.test.ts`:

```typescript
import { handleUpdateTask } from '../src/tools/update-task.ts';

  describe('update_task', () => {
    test('worker can update own task', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      // Create a task via send_message
      const sendResult = await handleSendMessage({
        room: 'frontend', text: 'Build login', to: 'builder-1', name: 'lead-1', kind: 'task',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;

      const result = await handleUpdateTask({ task_id: taskId, status: 'active', name: 'builder-1' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]!.text);
      expect(data.updated).toBe(true);
      expect(data.status).toBe('active');
    });

    test('worker cannot update another workers task', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-2', tmux_target: testPaneA });

      const sendResult = await handleSendMessage({
        room: 'frontend', text: 'Build login', to: 'builder-1', name: 'lead-1', kind: 'task',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;

      const result = await handleUpdateTask({ task_id: taskId, status: 'active', name: 'builder-2' });
      expect(result.isError).toBe(true);
    });

    test('non-worker is rejected', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const sendResult = await handleSendMessage({
        room: 'frontend', text: 'Build login', to: 'builder-1', name: 'lead-1', kind: 'task',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;

      const result = await handleUpdateTask({ task_id: taskId, status: 'active', name: 'lead-1' });
      expect(result.isError).toBe(true);
    });
  });
```

Run: `bun test test/tools.test.ts`
Expected: FAIL — module not found

- [ ] **Step 2: Implement `update_task` handler**

Create `src/tools/update-task.ts`:

```typescript
import { ok, err } from '../shared/types.ts';
import type { ToolResult, TaskStatus } from '../shared/types.ts';
import { assertRole } from '../shared/role-guard.ts';
import { getTask, updateTaskStatus } from '../state/index.ts';

interface UpdateTaskParams {
  task_id: number;
  status: string;
  note?: string;
  name: string;
}

const WORKER_ALLOWED: TaskStatus[] = ['queued', 'active', 'completed', 'error'];

export async function handleUpdateTask(params: UpdateTaskParams): Promise<ToolResult> {
  const { task_id, status, note, name } = params;

  if (!task_id || !status || !name) {
    return err('Missing required params: task_id, status, name');
  }

  if (!WORKER_ALLOWED.includes(status as TaskStatus)) {
    return err(`Invalid status "${status}". Allowed: ${WORKER_ALLOWED.join(', ')}`);
  }

  // Role check: worker only
  try {
    assertRole(name, ['worker'], 'update_task');
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }

  // Verify task exists and belongs to this worker
  const task = getTask(task_id);
  if (!task) {
    return err(`Task ${task_id} not found`);
  }
  if (task.assigned_to !== name) {
    return err(`Task ${task_id} is assigned to "${task.assigned_to}", not "${name}"`);
  }

  const updated = updateTaskStatus(task_id, status as TaskStatus, note);
  if (!updated) {
    return err(`Failed to update task ${task_id}`);
  }

  return ok({ updated: true, task_id, status: updated.status });
}
```

- [ ] **Step 3: Register tool in `src/index.ts`**

Add import at top:

```typescript
import { handleUpdateTask } from './tools/update-task.ts';
```

Add to tool list (after `set_room_topic` entry, line 154):

```typescript
    {
      name: 'update_task',
      description: 'Update a task\'s status. Worker-only: you can only update tasks assigned to you.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'number', description: 'Task ID to update' },
          status: { type: 'string', enum: ['queued', 'active', 'completed', 'error'], description: 'New task status' },
          note: { type: 'string', description: 'Optional note (e.g., error message)' },
          name: { type: 'string', description: 'Your agent name' },
        },
        required: ['task_id', 'status', 'name'],
      },
    },
```

Add to switch statement (line 181):

```typescript
      case 'update_task':
        return await handleUpdateTask(args as any);
```

- [ ] **Step 4: Run tests**

Run: `bun test`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/update-task.ts src/index.ts test/tools.test.ts
git commit -m "feat: add update_task tool with worker-only role enforcement"
```

---

### Task 11: Implement `interrupt_worker` Tool

**Files:**
- Create: `src/tools/interrupt-worker.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/tools.test.ts`:

```typescript
import { handleInterruptWorker } from '../src/tools/interrupt-worker.ts';

  describe('interrupt_worker', () => {
    test('leader can interrupt worker with active task', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      // Create and activate a task
      const sendResult = await handleSendMessage({
        room: 'frontend', text: 'Build login', to: 'builder-1', name: 'lead-1', kind: 'task',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;
      await handleUpdateTask({ task_id: taskId, status: 'active', name: 'builder-1' });

      const result = await handleInterruptWorker({ worker_name: 'builder-1', room: 'frontend', name: 'lead-1' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]!.text);
      expect(data.interrupted).toBe(true);
      expect(data.task_id).toBe(taskId);
    });

    test('worker cannot interrupt', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const result = await handleInterruptWorker({ worker_name: 'lead-1', room: 'frontend', name: 'builder-1' });
      expect(result.isError).toBe(true);
    });

    test('errors when no active task', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const result = await handleInterruptWorker({ worker_name: 'builder-1', room: 'frontend', name: 'lead-1' });
      expect(result.isError).toBe(true);
    });
  });
```

Run: `bun test test/tools.test.ts`
Expected: FAIL — module not found

- [ ] **Step 2: Implement `interrupt_worker` handler**

Create `src/tools/interrupt-worker.ts`:

```typescript
import { ok, err } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { assertRole } from '../shared/role-guard.ts';
import { getAgent, getTasksForAgent, updateTaskStatus, addMessage } from '../state/index.ts';
import { getQueue } from '../delivery/pane-queue.ts';

interface InterruptWorkerParams {
  worker_name: string;
  room: string;
  name: string;
}

export async function handleInterruptWorker(params: InterruptWorkerParams): Promise<ToolResult> {
  const { worker_name, room, name } = params;

  if (!worker_name || !room || !name) {
    return err('Missing required params: worker_name, room, name');
  }

  // Role check: leader or boss only
  try {
    assertRole(name, ['leader', 'boss'], 'interrupt_worker');
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }

  // Validate worker exists and is in room
  const worker = getAgent(worker_name);
  if (!worker) {
    return err(`Worker "${worker_name}" is not registered`);
  }
  if (!worker.rooms.includes(room)) {
    return err(`Worker "${worker_name}" is not in room "${room}"`);
  }

  // Find active task
  const activeTasks = getTasksForAgent(worker_name, ['active']);
  if (activeTasks.length === 0) {
    return err(`Worker "${worker_name}" has no active task to interrupt`);
  }

  const task = activeTasks[0]!;

  // Send Escape (priority — jumps to front of queue)
  await getQueue(worker.tmux_target).enqueue({ type: 'escape' });

  // Mark task as interrupted
  updateTaskStatus(task.id, 'interrupted');

  // Record and send system notification to worker
  const notifyBody = `Your current task was interrupted by ${name}`;
  const notifyText = `[system@${room}]: ${notifyBody}`;
  addMessage(worker_name, 'system', room, notifyBody, 'push', worker_name, 'status');
  await getQueue(worker.tmux_target).enqueue({ type: 'paste', text: notifyText });

  return ok({ interrupted: true, task_id: task.id, previous_status: 'active' });
}
```

- [ ] **Step 3: Register tool in `src/index.ts`**

Add import:

```typescript
import { handleInterruptWorker } from './tools/interrupt-worker.ts';
```

Add to tool list:

```typescript
    {
      name: 'interrupt_worker',
      description: 'Interrupt a busy worker by sending Escape to their pane. Leader/Boss only.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          worker_name: { type: 'string', description: 'Worker agent name to interrupt' },
          room: { type: 'string', description: 'Room the worker is in' },
          name: { type: 'string', description: 'Your agent name (caller)' },
        },
        required: ['worker_name', 'room', 'name'],
      },
    },
```

Add to switch:

```typescript
      case 'interrupt_worker':
        return await handleInterruptWorker(args as any);
```

- [ ] **Step 4: Run tests**

Run: `bun test`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/interrupt-worker.ts src/index.ts test/tools.test.ts
git commit -m "feat: add interrupt_worker tool with leader/boss role enforcement"
```

---

### Task 12: Implement `reassign_task` Tool

**Files:**
- Create: `src/tools/reassign-task.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/tools.test.ts`:

```typescript
import { handleReassignTask } from '../src/tools/reassign-task.ts';

  describe('reassign_task', () => {
    test('leader can reassign active task', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const sendResult = await handleSendMessage({
        room: 'frontend', text: 'Build login', to: 'builder-1', name: 'lead-1', kind: 'task',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;
      await handleUpdateTask({ task_id: taskId, status: 'active', name: 'builder-1' });

      const result = await handleReassignTask({
        worker_name: 'builder-1', room: 'frontend', text: 'Build signup instead', name: 'lead-1',
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]!.text);
      expect(data.reassigned).toBe(true);
      expect(data.old_task_id).toBe(taskId);
      expect(data.new_task_id).toBeDefined();
    });

    test('leader can reassign queued task', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const sendResult = await handleSendMessage({
        room: 'frontend', text: 'Build login', to: 'builder-1', name: 'lead-1', kind: 'task',
      });
      const taskId = JSON.parse(sendResult.content[0]!.text).task_id;
      await handleUpdateTask({ task_id: taskId, status: 'queued', name: 'builder-1' });

      const result = await handleReassignTask({
        worker_name: 'builder-1', room: 'frontend', text: 'Build signup instead', name: 'lead-1',
      });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.reassigned).toBe(true);
      expect(data.old_task_id).toBe(taskId);
    });

    test('leader can reassign to idle worker', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const result = await handleReassignTask({
        worker_name: 'builder-1', room: 'frontend', text: 'Build login', name: 'lead-1',
      });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.reassigned).toBe(true);
      expect(data.old_task_id).toBeUndefined();
      expect(data.new_task_id).toBeDefined();
    });

    test('worker cannot reassign', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      const result = await handleReassignTask({
        worker_name: 'lead-1', room: 'frontend', text: 'Do something', name: 'builder-1',
      });
      expect(result.isError).toBe(true);
    });
  });
```

Run: `bun test test/tools.test.ts`
Expected: FAIL — module not found

- [ ] **Step 2: Implement `reassign_task` handler**

Create `src/tools/reassign-task.ts`:

```typescript
import { ok, err } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { assertRole } from '../shared/role-guard.ts';
import { getAgent, getTasksForAgent, updateTaskStatus, createTask, addMessage } from '../state/index.ts';
import { getQueue } from '../delivery/pane-queue.ts';

interface ReassignTaskParams {
  worker_name: string;
  room: string;
  text: string;
  name: string;
}

export async function handleReassignTask(params: ReassignTaskParams): Promise<ToolResult> {
  const { worker_name, room, text, name } = params;

  if (!worker_name || !room || !text || !name) {
    return err('Missing required params: worker_name, room, text, name');
  }

  // Role check: leader or boss only
  try {
    assertRole(name, ['leader', 'boss'], 'reassign_task');
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }

  // Validate worker
  const worker = getAgent(worker_name);
  if (!worker) {
    return err(`Worker "${worker_name}" is not registered`);
  }
  if (!worker.rooms.includes(room)) {
    return err(`Worker "${worker_name}" is not in room "${room}"`);
  }

  const queue = getQueue(worker.tmux_target);
  let oldTaskId: number | undefined;

  // Check current task state
  const activeTasks = getTasksForAgent(worker_name, ['active']);
  const queuedTasks = getTasksForAgent(worker_name, ['queued']);

  if (activeTasks.length > 0) {
    // Active task: escape to interrupt, then send new task
    const oldTask = activeTasks[0]!;
    oldTaskId = oldTask.id;
    await queue.enqueue({ type: 'escape' });
    updateTaskStatus(oldTask.id, 'interrupted');
  } else if (queuedTasks.length > 0) {
    // Queued task: Ctrl-L to clear input, then send new task
    const oldTask = queuedTasks[0]!;
    oldTaskId = oldTask.id;
    await queue.enqueue({ type: 'clear' });
    updateTaskStatus(oldTask.id, 'cancelled');
  }
  // else: idle — just send new task

  // Queue message and create task record
  const header = `[${name}@${room}]:`;
  const fullText = `${header} ${text}`;
  const msg = addMessage(worker_name, name, room, text, 'push', worker_name, 'task');
  const newTask = createTask(room, worker_name, name, Number(msg.message_id), text);

  // Deliver new task
  await queue.enqueue({ type: 'paste', text: fullText });

  return ok({
    reassigned: true,
    old_task_id: oldTaskId,
    new_task_id: newTask.id,
  });
}
```

- [ ] **Step 3: Register tool in `src/index.ts`**

Add import:

```typescript
import { handleReassignTask } from './tools/reassign-task.ts';
```

Add to tool list:

```typescript
    {
      name: 'reassign_task',
      description: 'Replace a worker\'s current or queued task with a new one. Leader/Boss only. Handles interrupt/clear automatically based on task state.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          worker_name: { type: 'string', description: 'Worker agent name' },
          room: { type: 'string', description: 'Room the worker is in' },
          text: { type: 'string', description: 'New task text' },
          name: { type: 'string', description: 'Your agent name (caller)' },
        },
        required: ['worker_name', 'room', 'text', 'name'],
      },
    },
```

Add to switch:

```typescript
      case 'reassign_task':
        return await handleReassignTask(args as any);
```

- [ ] **Step 4: Run tests**

Run: `bun test`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/reassign-task.ts src/index.ts test/tools.test.ts
git commit -m "feat: add reassign_task tool with leader/boss role enforcement"
```

---

### Task 13: Enhance `get_status` with Task Info

**Files:**
- Modify: `src/tools/get-status.ts`

- [ ] **Step 1: Write failing test**

Add to `test/tools.test.ts`:

```typescript
import { handleGetStatus } from '../src/tools/get-status.ts';

  describe('get_status with tasks', () => {
    test('includes current and queued tasks in response', async () => {
      await handleJoinRoom({ room: 'frontend', role: 'leader', name: 'lead-1', tmux_target: testPaneA });
      await handleJoinRoom({ room: 'frontend', role: 'worker', name: 'builder-1', tmux_target: testPaneB });

      // Create two tasks
      const r1 = await handleSendMessage({ room: 'frontend', text: 'Task A', to: 'builder-1', name: 'lead-1', kind: 'task' });
      const r2 = await handleSendMessage({ room: 'frontend', text: 'Task B', to: 'builder-1', name: 'lead-1', kind: 'task' });
      const t1 = JSON.parse(r1.content[0]!.text).task_id;
      const t2 = JSON.parse(r2.content[0]!.text).task_id;
      await handleUpdateTask({ task_id: t1, status: 'active', name: 'builder-1' });
      await handleUpdateTask({ task_id: t2, status: 'queued', name: 'builder-1' });

      const result = await handleGetStatus({ agent_name: 'builder-1' });
      const data = JSON.parse(result.content[0]!.text);
      expect(data.current_task).toBeDefined();
      expect(data.current_task.id).toBe(t1);
      expect(data.current_task.status).toBe('active');
      expect(data.queued_tasks).toBeDefined();
      expect(data.queued_tasks.length).toBe(1);
      expect(data.queued_tasks[0].id).toBe(t2);
    });
  });
```

Run: `bun test test/tools.test.ts`
Expected: FAIL — `current_task` not in response

- [ ] **Step 2: Update `handleGetStatus`**

In `src/tools/get-status.ts`, add import:

```typescript
import { getTasksForAgent } from '../state/index.ts';
```

In the final `return ok({...})` block (line 45), add task info:

```typescript
  // Get task info for this agent
  const activeTasks = getTasksForAgent(targetName, ['active']);
  const queuedTasks = getTasksForAgent(targetName, ['queued', 'sent']);

  const currentTask = activeTasks.length > 0 ? {
    id: activeTasks[0]!.id,
    status: activeTasks[0]!.status,
    summary: activeTasks[0]!.summary,
  } : null;

  const queuedTasksList = queuedTasks.map(t => ({
    id: t.id,
    status: t.status,
    summary: t.summary,
  }));

  return ok({
    agent_id: agent.agent_id,
    name: agent.name,
    role: agent.role,
    rooms: agent.rooms,
    status,
    tmux_target: agent.tmux_target,
    last_activity_ts: agent.last_activity ?? agent.joined_at,
    current_task: currentTask,
    queued_tasks: queuedTasksList,
  });
```

Also update the `dead` return block (lines 27-35) to include task info. Move the task query code **before** the dead check so it runs for both paths:

```typescript
  // Get task info (before dead check — dead agents may still have tasks)
  const activeTasks = getTasksForAgent(targetName, ['active']);
  const queuedTasks = getTasksForAgent(targetName, ['queued', 'sent']);
  const currentTask = activeTasks.length > 0 ? {
    id: activeTasks[0]!.id, status: activeTasks[0]!.status, summary: activeTasks[0]!.summary,
  } : null;
  const queuedTasksList = queuedTasks.map(t => ({ id: t.id, status: t.status, summary: t.summary }));
```

Then include `current_task` and `queued_tasks` in both the dead and alive return objects.

- [ ] **Step 3: Run tests**

Run: `bun test`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/tools/get-status.ts test/tools.test.ts
git commit -m "feat: include task info in get_status response"
```

---

## Chunk 4: Skills & Dashboard

### Task 14: Update Skills

**Files:**
- Modify: `skills/worker/SKILL.md`
- Modify: `skills/leader/SKILL.md`
- Modify: `skills/boss/SKILL.md`

- [ ] **Step 1: Update worker skill**

Add to `skills/worker/SKILL.md` after "## Error Handling" section:

```markdown
## Task Status Tracking

When you receive a task, update its status using `update_task`:

1. **If you're busy** when a task arrives, report it as queued:
   ```
   update_task({ task_id: <id>, status: "queued", name: "your-name" })
   ```

2. **When you start working** on a task:
   ```
   update_task({ task_id: <id>, status: "active", name: "your-name" })
   ```

3. **When you finish** a task:
   ```
   update_task({ task_id: <id>, status: "completed", name: "your-name" })
   ```

4. **If you hit an error:**
   ```
   update_task({ task_id: <id>, status: "error", note: "Description of what went wrong", name: "your-name" })
   ```

The `task_id` is returned in the original task message from your leader.

## Handling Interruptions

If your leader sends an Escape to interrupt your current task, you'll see a system notification:
```
[system@room]: Your current task was interrupted by leader-name
```

When this happens:
1. Stop what you're doing
2. Check `read_messages` for new instructions from your leader
3. Follow the new instructions
```

- [ ] **Step 2: Update leader skill**

Add to `skills/leader/SKILL.md` after "## Task Assignment" section:

```markdown
## Worker Control

### Checking Worker Tasks

Use `get_status` to see what a worker is currently doing:
```
get_status({ agent_name: "builder-1" })
```
Response includes `current_task` (active task) and `queued_tasks`.

### Interrupting a Hanging Worker

If a worker is stuck on a long-running task:
```
interrupt_worker({ worker_name: "builder-1", room: "frontend", name: "your-name" })
```
This sends Escape to the worker's pane and marks their active task as interrupted. The worker receives a system notification and should check for new instructions.

### Replacing a Task

To replace a worker's current or queued task with a new one:
```
reassign_task({ worker_name: "builder-1", room: "frontend", text: "New task description", name: "your-name" })
```
This automatically handles the interrupt/clear sequence based on whether the task is active or queued.

### Decision Guide
- Worker hanging too long → `interrupt_worker`, then send new instructions
- Wrong task queued/active → `reassign_task` with corrected text
- Worker idle → normal `send_message` with `kind: "task"`
```

- [ ] **Step 3: Update boss skill**

Add to `skills/boss/SKILL.md` after "## Strategic Direction" section:

```markdown
## Direct Worker Control

In escalation scenarios, you can directly control workers:

- **Interrupt:** `interrupt_worker({ worker_name: "name", room: "room", name: "your-name" })`
- **Reassign:** `reassign_task({ worker_name: "name", room: "room", text: "new task", name: "your-name" })`

Use these sparingly — normally delegate control to the room's leader. Direct intervention is for urgent situations only.
```

- [ ] **Step 4: Commit**

```bash
git add skills/worker/SKILL.md skills/leader/SKILL.md skills/boss/SKILL.md
git commit -m "docs: update skills with task tracking and worker control guidance"
```

---

### Task 15: Upgrade Dashboard — useTaskTracker

**Files:**
- Modify: `src/dashboard/hooks/useTaskTracker.ts`
- Modify: `src/dashboard/hooks/useStateReader.ts`

- [ ] **Step 1: Add tasks to `DashboardState` and `readAll`**

In `src/dashboard/hooks/useStateReader.ts`, add to the `DashboardState` interface:

```typescript
import type { Task } from '../../shared/types.ts';

export interface DashboardState {
  agents: Record<string, Agent>;
  rooms: Record<string, Room>;
  messages: Message[];
  tasks: Task[];
}
```

Update `EMPTY_STATE`:

```typescript
const EMPTY_STATE: DashboardState = { agents: {}, rooms: {}, messages: [], tasks: [] };
```

In the `readAll` function, add after the `messageRows` query:

```typescript
    const taskRows = db.query<{
      id: number; room: string; assigned_to: string; created_by: string;
      message_id: number | null; summary: string; status: string; note: string | null;
      created_at: string; updated_at: string;
    }, []>('SELECT * FROM tasks ORDER BY id ASC').all();
```

Add task mapping before the return:

```typescript
    const tasks: Task[] = taskRows.map(row => ({
      id: row.id,
      room: row.room,
      assigned_to: row.assigned_to,
      created_by: row.created_by,
      message_id: row.message_id,
      summary: row.summary,
      status: row.status as Task['status'],
      note: row.note ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
    return { agents, rooms, messages, tasks };
```

Update `quickHash` to include task count:

```typescript
function quickHash(state: DashboardState): string {
  const agentKeys = Object.keys(state.agents).sort().join(',');
  const roomKeys = Object.keys(state.rooms).sort().join(',');
  const msgCount = state.messages.length;
  const lastMsgId = state.messages[state.messages.length - 1]?.message_id ?? '';
  const taskCount = state.tasks.length;
  const lastTaskStatus = state.tasks[state.tasks.length - 1]?.status ?? '';
  return `${agentKeys}|${roomKeys}|${msgCount}|${lastMsgId}|${taskCount}|${lastTaskStatus}`;
}
```

- [ ] **Step 2: Rewrite `useTaskTracker` to use `tasks` table**

Replace the entire content of `src/dashboard/hooks/useTaskTracker.ts`:

```typescript
import { useMemo } from 'react';
import type { Task, TaskStatus } from '../../shared/types.ts';

export interface TrackedTask {
  id: number;
  text: string;
  agent: string;
  room: string;
  assignedAt: number;
  status: TaskStatus;
  duration: number | null;
  updatedAt: number;
}

export function useTaskTracker(tasks: Task[], room: string | null): TrackedTask[] {
  return useMemo(() => {
    if (!room) return [];

    const roomTasks = tasks.filter(t => t.room === room);

    const tracked: TrackedTask[] = roomTasks.map(t => {
      const assignedAt = new Date(t.created_at).getTime();
      const updatedAt = new Date(t.updated_at).getTime();
      const isTerminal = ['completed', 'error', 'cancelled'].includes(t.status);
      const duration = isTerminal ? updatedAt - assignedAt : null;

      return {
        id: t.id,
        text: t.summary,
        agent: t.assigned_to,
        room: t.room,
        assignedAt,
        status: t.status,
        duration,
        updatedAt,
      };
    });

    // Sort: active first, then queued/sent, then terminal (newest first)
    const ORDER: Record<string, number> = {
      active: 0, queued: 1, sent: 2, interrupted: 3,
      completed: 4, error: 5, cancelled: 6,
    };

    tracked.sort((a, b) => {
      const oa = ORDER[a.status] ?? 9;
      const ob = ORDER[b.status] ?? 9;
      if (oa !== ob) return oa - ob;
      if (oa <= 3) return a.assignedAt - b.assignedAt; // active/queued: oldest first
      return b.updatedAt - a.updatedAt; // terminal: newest first
    });

    return tracked;
  }, [tasks, room]);
}

export function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  if (mins < 60) return remainSecs > 0 ? `${mins}m${remainSecs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hours}h${remainMins}m` : `${hours}h`;
}
```

- [ ] **Step 3: Update consumers**

In `src/dashboard/components/DetailsPanel.tsx`, update the `useTaskTracker` call (line 28):

```typescript
const trackedTasks = useTaskTracker(/* was: messages, roomName */ tasks, roomName);
```

This requires passing `tasks` as a prop. Update `DetailsPanelProps`:

```typescript
interface DetailsPanelProps {
  agent: Agent | null;
  agentStatus: AgentStatusEntry | null;
  selectedNode: TreeNode | null;
  rooms: Record<string, Room>;
  messages: Message[];
  tasks: Task[];       // ADD
  isSyncing: boolean;
  height: number;
}
```

In `App.tsx`, pass `tasks` to DetailsPanel:

```typescript
<DetailsPanel
  ...existing props...
  tasks={state.tasks}
/>
```

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/hooks/useTaskTracker.ts src/dashboard/hooks/useStateReader.ts src/dashboard/components/DetailsPanel.tsx src/dashboard/App.tsx
git commit -m "feat: rewrite useTaskTracker to read from tasks table"
```

---

### Task 16: Upgrade Dashboard — Task Display

**Files:**
- Modify: `src/dashboard/components/DetailsPanel.tsx`
- Modify: `src/dashboard/components/HeaderStats.tsx`
- Modify: `src/dashboard/components/TreePanel.tsx`

- [ ] **Step 1: Update task icons in DetailsPanel**

In `src/dashboard/components/DetailsPanel.tsx`, update `RoomDetails` to use new status icons:

```typescript
const TASK_ICONS: Record<string, { icon: string; color: string }> = {
  active: { icon: '●', color: 'yellow' },
  queued: { icon: '◌', color: 'gray' },
  sent: { icon: '→', color: 'cyan' },
  completed: { icon: '✓', color: 'green' },
  error: { icon: '✗', color: 'red' },
  cancelled: { icon: '⊘', color: 'gray' },
  interrupted: { icon: '⚡', color: 'magenta' },
};
```

Replace the task rendering block in `RoomDetails` (lines 111-127):

```typescript
          {trackedTasks.map(t => {
            const { icon, color } = TASK_ICONS[t.status] ?? { icon: '?', color: 'gray' };
            const elapsed = t.duration != null
              ? formatDuration(t.duration)
              : formatDuration(Date.now() - t.assignedAt);
            return (
              <Text key={t.id} wrap="truncate">
                <Text color={color}> {icon} </Text>
                <Text>{t.text}</Text>
                <Text dimColor>  {t.agent}  {elapsed}</Text>
              </Text>
            );
          })}
```

Also update `AgentDetails` stats to use task data from the new `TrackedTask` shape (update the `agentStats` useMemo to count by `status` field instead of heuristic message matching).

- [ ] **Step 2: Update HeaderStats with task breakdown**

In `src/dashboard/components/HeaderStats.tsx`, update the stats computation to accept tasks and show breakdown. Add `tasks` to props:

```typescript
import type { Task } from '../../shared/types.ts';

interface HeaderStatsProps {
  statuses: Map<string, AgentStatusEntry>;
  messages: Message[];
  tasks: Task[];
  earliestJoinedAt: string | null;
  cols: number;
}
```

Update the stats computation:

```typescript
    let active = 0, queued = 0, done = 0, errors = 0;
    for (const t of tasks) {
      if (t.status === 'active') active++;
      else if (t.status === 'queued' || t.status === 'sent') queued++;
      else if (t.status === 'completed') done++;
      else if (t.status === 'error') errors++;
    }
```

Update the display:

```typescript
        <Text dimColor> │ Tasks: </Text>
        <Text color="green">{stats.done}</Text><Text dimColor> done</Text>
        {stats.active > 0 && <><Text dimColor>  </Text><Text color="yellow">{stats.active}</Text><Text dimColor> active</Text></>}
        {stats.queued > 0 && <><Text dimColor>  </Text><Text>{stats.queued}</Text><Text dimColor> queued</Text></>}
        {stats.errors > 0 && <><Text dimColor>  </Text><Text color="red">{stats.errors}</Text><Text dimColor> err</Text></>}
```

In `App.tsx`, pass `tasks` to `HeaderStats`:

```typescript
<HeaderStats statuses={statuses} messages={state.messages} tasks={state.tasks} earliestJoinedAt={earliestJoinedAt} cols={cols} />
```

- [ ] **Step 3: Add task indicators to TreePanel**

In `src/dashboard/components/TreePanel.tsx`, add `tasks` prop and show inline indicators:

Add to imports and props:

```typescript
import type { Task } from '../../shared/types.ts';

interface TreePanelProps {
  ...existing...
  tasks: Task[];
}
```

Add a `useMemo` for per-agent task counts:

```typescript
  const taskCounts = useMemo(() => {
    const counts = new Map<string, { active: number; queued: number }>();
    for (const t of tasks) {
      if (t.status !== 'active' && t.status !== 'queued' && t.status !== 'sent') continue;
      const c = counts.get(t.assigned_to) ?? { active: 0, queued: 0 };
      if (t.status === 'active') c.active++;
      else c.queued++;
      counts.set(t.assigned_to, c);
    }
    return counts;
  }, [tasks]);
```

In the agent rendering, after the error badge, add task indicators:

```typescript
            {(() => {
              const tc = node.agentName ? taskCounts.get(node.agentName) : undefined;
              if (!tc) return null;
              return (
                <>
                  {tc.active > 0 && <Text color="yellow"> ●{tc.active}</Text>}
                  {tc.queued > 0 && <Text dimColor> ◌{tc.queued}</Text>}
                </>
              );
            })()}
```

In `App.tsx`, pass `tasks` to `TreePanel`:

```typescript
<TreePanel ...existing... tasks={state.tasks} />
```

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/components/DetailsPanel.tsx src/dashboard/components/HeaderStats.tsx src/dashboard/components/TreePanel.tsx src/dashboard/App.tsx
git commit -m "feat: upgrade dashboard with authoritative task status display"
```

---

### Task 17: Add Message Feed Badges & Filters

**Files:**
- Modify: `src/dashboard/components/MessageFeed.tsx`
- Modify: `src/dashboard/App.tsx`

- [ ] **Step 1: Add new badges to MessageFeed**

In `src/dashboard/components/MessageFeed.tsx`, update the badge maps:

```typescript
const KIND_COLORS: Record<string, string> = {
  task: 'cyan', completion: 'green', error: 'red', question: 'yellow',
  interrupted: 'magenta', cancelled: 'gray',
};
const KIND_BADGES: Record<string, string> = {
  task: '[TASK]', completion: '[DONE]', error: '[ERR]', question: '[?]',
  interrupted: '[INT]', cancelled: '[CXL]',
};
```

- [ ] **Step 2: Add filter toggles for keys 7-8 in App.tsx**

In `src/dashboard/App.tsx`, update `ALL_KINDS` to include new kinds:

```typescript
const ALL_KINDS: MessageKind[] = ['task', 'completion', 'error', 'question', 'status', 'chat'];
```

Note: `interrupted` and `cancelled` are task statuses, not message kinds. The `[INT]` and `[CXL]` badges will show on system messages (kind: 'chat' or 'status') that contain interrupt/cancel notifications. No new MessageKind values needed — the badge logic can check message text patterns instead.

Alternatively, if we want filter toggles, we can add synthetic kind matching in the feed hook. This is a minor UX enhancement — skip for now and add in a follow-up if needed.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/components/MessageFeed.tsx
git commit -m "feat: add interrupt and cancel badges to message feed"
```

---

## Chunk 5: Documentation & Final Verification

### Task 18: Update Architecture Docs

**Files:**
- Modify: `docs/architecture.md`
- Modify: `README.md`

- [ ] **Step 1: Update `docs/architecture.md`**

Add a new section for task tracking and worker control:

```markdown
## Task Tracking & Worker Control

### Task Lifecycle
Tasks are tracked in a dedicated `tasks` SQLite table with statuses:
`sent → queued → active → completed/error/interrupted/cancelled`

Tasks are automatically created when `send_message` is called with `kind: "task"`.
Workers update task status via `update_task`. Dead agent tasks are cleaned up automatically.

### Worker Control Tools
- `interrupt_worker` — Leader/Boss only. Sends Escape to worker pane, marks task interrupted.
- `reassign_task` — Leader/Boss only. Replaces queued/active task with new one.
- `update_task` — Worker only. Reports task lifecycle transitions.

### Role Enforcement
The `assertRole` guard (`src/shared/role-guard.ts`) enforces role-based access on control tools.
Existing tools remain role-agnostic.

### Per-Pane Delivery Queue
All tmux output is routed through `PaneQueue` (`src/delivery/pane-queue.ts`):
- One queue per pane, serializes deliveries within a process
- Cross-process serialization via per-pane file locks (`/tmp/crew/locks/`)
- Escape items get priority (jump to front of queue)
- Polls for idle prompt before delivering paste items
- Per-pane buffer names (`_crew_{pane_id}`) prevent cross-pane buffer collisions
```

- [ ] **Step 2: Update `README.md`**

Add new tools to the tool reference section. Add task tracking to the features list.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md README.md
git commit -m "docs: update architecture and README for task tracking and worker control"
```

---

### Task 19: Run Full Test Suite & Verify

- [ ] **Step 1: Run all unit/integration tests**

Run: `bun test`
Expected: All PASS

- [ ] **Step 2: Run send reliability UAT**

Run: `bun test/uat-send-reliability.ts`
Expected: PASS — verify pane queue doesn't break existing delivery

- [ ] **Step 3: Manual smoke test**

Start the MCP server and dashboard:
1. Open tmux with test panes
2. Join agents with different roles
3. Send a task, verify task_id is returned
4. Call update_task as worker
5. Call interrupt_worker as leader
6. Call reassign_task as leader
7. Verify dashboard shows task status indicators

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address issues found in final verification"
```
