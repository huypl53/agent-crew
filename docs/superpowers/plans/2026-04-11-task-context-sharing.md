# Task Context Sharing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable worker handoff via structured context on completed tasks and queryable task history.

**Architecture:** Add `context` TEXT column to tasks table, two new MCP tools (`get_task_details`, `search_tasks`), extend `update_task` to accept context. SQLite LIKE for search.

**Tech Stack:** TypeScript, Bun, SQLite (bun:sqlite), MCP SDK

---

## Chunk 1: Schema + State Layer

### Task 1: Add context column to tasks table and Task type

**Files:**
- Modify: `src/state/db.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add context to Task interface**

In `src/shared/types.ts`, add `context` to the Task interface:

```ts
export interface Task {
  id: number;
  room: string;
  assigned_to: string;
  created_by: string;
  message_id: number | null;
  summary: string;
  status: TaskStatus;
  note?: string;
  context?: string;  // ADD THIS
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 2: Add context column to schema**

In `src/state/db.ts`, update the tasks CREATE TABLE to add the context column after `note`:

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
    context     TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
```

- [ ] **Step 3: Run tests**

Run: `bun test`
Expected: All pass (new column has no NOT NULL constraint, backward compatible)

- [ ] **Step 4: Commit**

```bash
git add src/state/db.ts src/shared/types.ts
git commit -m "feat: add context column to tasks table for worker handoff"
```

---

### Task 2: Add state layer functions (getTaskDetails, searchTasks, updateTaskStatus context)

**Files:**
- Modify: `src/state/index.ts`
- Modify: `test/state.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/state.test.ts`:

```ts
import { getTaskDetails, searchTasks } from '../src/state/index.ts';

describe('task context sharing', () => {
  test('getTaskDetails returns full task with context', () => {
    // Create a task, update it with context
    const task = createTask('test-room', 'wk-01', 'lead-01', null, 'test task summary');
    updateTaskStatus(task.id, 'active');
    updateTaskStatus(task.id, 'completed', 'done', 'Explored src/auth.ts. Found JWT validation is in middleware.');
    const details = getTaskDetails(task.id);
    expect(details).toBeTruthy();
    expect(details!.context).toContain('JWT validation');
  });

  test('searchTasks by keyword finds matching tasks', () => {
    const t1 = createTask('test-room', 'wk-01', 'lead-01', null, 'fix auth bug');
    updateTaskStatus(t1.id, 'active');
    updateTaskStatus(t1.id, 'completed', undefined, 'Found issue in JWT middleware');
    const t2 = createTask('test-room', 'wk-02', 'lead-01', null, 'add login form');
    updateTaskStatus(t2.id, 'active');
    updateTaskStatus(t2.id, 'completed', undefined, 'Created React component');
    
    const results = searchTasks({ keyword: 'JWT' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].summary).toContain('auth');
  });

  test('searchTasks by room filters correctly', () => {
    createTask('room-a', 'wk-01', 'lead-01', null, 'task in room a');
    createTask('room-b', 'wk-02', 'lead-01', null, 'task in room b');
    const results = searchTasks({ room: 'room-a' });
    expect(results.every(r => r.room === 'room-a')).toBe(true);
  });

  test('searchTasks by assigned_to filters correctly', () => {
    const results = searchTasks({ assigned_to: 'wk-01' });
    expect(results.every(r => r.assigned_to === 'wk-01')).toBe(true);
  });

  test('searchTasks returns context_preview truncated to 200 chars', () => {
    const longContext = 'x'.repeat(500);
    const t = createTask('test-room', 'wk-01', 'lead-01', null, 'long context task');
    updateTaskStatus(t.id, 'active');
    updateTaskStatus(t.id, 'completed', undefined, longContext);
    const results = searchTasks({ keyword: 'long context' });
    if (results.length > 0) {
      expect(results[0].context_preview!.length).toBeLessThanOrEqual(203); // 200 + "..."
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/state.test.ts`
Expected: FAIL (functions not found)

- [ ] **Step 3: Implement state functions**

In `src/state/index.ts`:

1. Update `updateTaskStatus` to accept optional `context` parameter:

```ts
export function updateTaskStatus(id: number, status: TaskStatus, note?: string, context?: string): Task | undefined {
  const db = getDb();
  const existing = getTask(id);
  if (!existing) return undefined;

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
  if (context !== undefined) {
    sql += ', context = ?';
    params.push(context);
  }
  sql += ' WHERE id = ?';
  params.push(id);
  db.run(sql, params);
  return getTask(id);
}
```

2. Add `getTaskDetails`:

```ts
export function getTaskDetails(id: number): Task | undefined {
  return getTask(id); // getTask already returns full record including context
}
```

3. Add `searchTasks`:

```ts
interface SearchTasksParams {
  room?: string;
  assigned_to?: string;
  keyword?: string;
  status?: string;
  limit?: number;
}

interface SearchResult {
  id: number;
  room: string;
  assigned_to: string;
  created_by: string;
  summary: string;
  status: string;
  context_preview: string | null;
  updated_at: string;
}

export function searchTasks(params: SearchTasksParams): SearchResult[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.room) {
    conditions.push('room = ?');
    values.push(params.room);
  }
  if (params.assigned_to) {
    conditions.push('assigned_to = ?');
    values.push(params.assigned_to);
  }
  if (params.status) {
    conditions.push('status = ?');
    values.push(params.status);
  }
  if (params.keyword) {
    conditions.push('(summary LIKE ? OR context LIKE ?)');
    const pattern = `%${params.keyword}%`;
    values.push(pattern, pattern);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = params.limit ?? 10;
  const sql = `SELECT id, room, assigned_to, created_by, summary, status, context, updated_at FROM tasks ${where} ORDER BY updated_at DESC LIMIT ?`;
  values.push(limit);

  const rows = db.prepare(sql).all(...values) as any[];
  return rows.map(row => ({
    id: row.id,
    room: row.room,
    assigned_to: row.assigned_to,
    created_by: row.created_by,
    summary: row.summary,
    status: row.status,
    context_preview: row.context ? (row.context.length > 200 ? row.context.slice(0, 200) + '...' : row.context) : null,
    updated_at: row.updated_at,
  }));
}
```

Also update `rowToTask` (if it exists) or `getTask` to include `context` in the returned Task object. Check if `getTask` uses `SELECT *` — if so, context is already included. Just make sure the mapping includes it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/state.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/state/index.ts test/state.test.ts
git commit -m "feat: add getTaskDetails and searchTasks state functions"
```

---

## Chunk 2: MCP Tools

### Task 3: Create get_task_details tool handler

**Files:**
- Create: `src/tools/get-task-details.ts`
- Modify: `test/tools.test.ts`

- [ ] **Step 1: Write failing test**

Add to `test/tools.test.ts`:

```ts
import { handleGetTaskDetails } from '../src/tools/get-task-details.ts';

describe('get_task_details', () => {
  test('returns full task with context', async () => {
    // Setup: create and complete a task with context
    const task = createTask('test-room', 'wk-01', 'lead-01', null, 'test task');
    updateTaskStatus(task.id, 'active');
    updateTaskStatus(task.id, 'completed', undefined, 'Found auth issue in middleware');
    
    const result = await handleGetTaskDetails({ task_id: task.id });
    const data = JSON.parse(result.content[0].text);
    expect(data.context).toContain('auth issue');
  });

  test('returns error for nonexistent task', async () => {
    const result = await handleGetTaskDetails({ task_id: 99999 });
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `bun test test/tools.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement handler**

Create `src/tools/get-task-details.ts`:

```ts
import { ok, err } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { getTaskDetails } from '../state/index.ts';

interface GetTaskDetailsParams {
  task_id: number;
}

export async function handleGetTaskDetails(params: GetTaskDetailsParams): Promise<ToolResult> {
  const { task_id } = params;
  if (!task_id) return err('Missing required param: task_id');

  const task = getTaskDetails(task_id);
  if (!task) return err(`Task ${task_id} not found`);

  return ok(task);
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test test/tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/get-task-details.ts test/tools.test.ts
git commit -m "feat: add get_task_details MCP tool handler"
```

---

### Task 4: Create search_tasks tool handler

**Files:**
- Create: `src/tools/search-tasks.ts`
- Modify: `test/tools.test.ts`

- [ ] **Step 1: Write failing test**

Add to `test/tools.test.ts`:

```ts
import { handleSearchTasks } from '../src/tools/search-tasks.ts';

describe('search_tasks', () => {
  test('searches by keyword', async () => {
    const task = createTask('test-room', 'wk-01', 'lead-01', null, 'fix auth middleware');
    updateTaskStatus(task.id, 'active');
    updateTaskStatus(task.id, 'completed', undefined, 'JWT tokens expire too early');

    const result = await handleSearchTasks({ keyword: 'JWT' });
    const data = JSON.parse(result.content[0].text);
    expect(data.length).toBeGreaterThan(0);
  });

  test('searches by room', async () => {
    const result = await handleSearchTasks({ room: 'test-room' });
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data)).toBe(true);
  });

  test('returns empty array for no matches', async () => {
    const result = await handleSearchTasks({ keyword: 'zzz_nonexistent_zzz' });
    const data = JSON.parse(result.content[0].text);
    expect(data).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify fail**

- [ ] **Step 3: Implement handler**

Create `src/tools/search-tasks.ts`:

```ts
import { ok } from '../shared/types.ts';
import type { ToolResult } from '../shared/types.ts';
import { searchTasks } from '../state/index.ts';

interface SearchTasksParams {
  room?: string;
  assigned_to?: string;
  keyword?: string;
  status?: string;
  limit?: number;
}

export async function handleSearchTasks(params: SearchTasksParams): Promise<ToolResult> {
  const results = searchTasks({
    room: params.room,
    assigned_to: params.assigned_to,
    keyword: params.keyword,
    status: params.status ?? 'completed',
    limit: params.limit,
  });

  return ok(results);
}
```

- [ ] **Step 4: Run test to verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/tools/search-tasks.ts test/tools.test.ts
git commit -m "feat: add search_tasks MCP tool handler"
```

---

### Task 5: Extend update_task to accept context + wire new tools into index.ts

**Files:**
- Modify: `src/tools/update-task.ts`
- Modify: `src/index.ts`
- Modify: `test/tools.test.ts`

- [ ] **Step 1: Write failing test for context in update_task**

Add to `test/tools.test.ts`:

```ts
describe('update_task context', () => {
  test('worker can set context on completion', async () => {
    // Create task assigned to a worker
    addAgent('ctx-worker', 'worker', 'test-room', '%999');
    const task = createTask('test-room', 'ctx-worker', 'lead-01', null, 'context test');
    updateTaskStatus(task.id, 'active');

    const result = await handleUpdateTask({
      task_id: task.id,
      status: 'completed',
      context: 'Found issue in src/auth.ts line 42',
      name: 'ctx-worker',
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.updated).toBe(true);

    const details = getTaskDetails(task.id);
    expect(details!.context).toContain('src/auth.ts');
  });
});
```

- [ ] **Step 2: Update update_task handler**

In `src/tools/update-task.ts`, add `context` to the params interface and pass it through:

```ts
interface UpdateTaskParams {
  task_id: number;
  status: string;
  note?: string;
  context?: string;  // ADD THIS
  name: string;
}
```

Update the call to `updateTaskStatus`:

```ts
const updated = updateTaskStatus(task_id, status as TaskStatus, note, context);
```

- [ ] **Step 3: Register new tools in index.ts**

In `src/index.ts`, add imports:

```ts
import { handleGetTaskDetails } from './tools/get-task-details.ts';
import { handleSearchTasks } from './tools/search-tasks.ts';
```

Add tool definitions to the tools array:

```ts
{
  name: 'get_task_details',
  description: 'Get full details of a task including worker context notes. Use to read what a previous worker learned.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'number', description: 'Task ID to look up' },
    },
    required: ['task_id'],
  },
},
{
  name: 'search_tasks',
  description: 'Search completed tasks by room, agent, keyword, or status. Use to find relevant context from previous work.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      room: { type: 'string', description: 'Filter by room name' },
      assigned_to: { type: 'string', description: 'Filter by agent name' },
      keyword: { type: 'string', description: 'Search keyword (matches summary and context)' },
      status: { type: 'string', description: 'Filter by status (default: completed)' },
      limit: { type: 'number', description: 'Max results (default: 10)' },
    },
  },
},
```

Also add `context` to the existing `update_task` tool schema:

```ts
context: { type: 'string', description: 'Worker context notes for handoff (what you learned, files explored, key findings)' },
```

Add cases to the switch:

```ts
case 'get_task_details':
  return await handleGetTaskDetails(args as any);
case 'search_tasks':
  return await handleSearchTasks(args as any);
```

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/tools/update-task.ts src/index.ts test/tools.test.ts
git commit -m "feat: wire get_task_details and search_tasks into MCP server"
```

---

## Chunk 3: Docs & Verification

### Task 6: Update docs

**Files:**
- Modify: `docs/architecture.md`
- Modify: `README.md`

- [ ] **Step 1: Update architecture.md**

Add a new section "## Task Context Sharing" covering:
- Purpose: worker handoff — agents write structured context on task completion
- Schema: `context` TEXT column on tasks table
- New tools: `get_task_details`, `search_tasks`
- Usage pattern: worker completes task → writes context → next worker searches → reads context → starts informed

- [ ] **Step 2: Update README.md**

Add to features list:
- Task context sharing for worker handoff
- New tools: `get_task_details`, `search_tasks`

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md README.md
git commit -m "docs: add task context sharing architecture and README updates"
```

---

### Task 7: Full verification

- [ ] **Step 1: Run full test suite 3 times**

```bash
bun test && bun test && bun test
```

Expected: All pass, all 3 runs

- [ ] **Step 2: Report final count**
