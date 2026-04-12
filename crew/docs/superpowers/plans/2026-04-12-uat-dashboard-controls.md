# UAT Plan: Dashboard Controls (Task 9)

## Goal

Verify that the six dashboard action functions correctly mutate SQLite state and invoke the
right tmux calls. Because the TUI itself is not scriptable, tests target the action functions
directly via their exported TypeScript API.

---

## Prerequisites

- Isolated `CREW_STATE_DIR` (temp dir, cleaned per test)
- `initDb(':memory:')` or a temp `.db` file so tests are side-effect-free
- A mock / stub for `paneExists`, `sendEscape`, `sendKeys` from `src/tmux/index.ts` — inject
  via env or module-level patching so no real tmux session is required
- Import sources:
  - `src/dashboard/actions/agent-actions.ts` — `revokeAgent`, `interruptAgent`, `clearAgentSession`
  - `src/dashboard/actions/task-actions.ts` — `interruptTask`, `cancelTask`, `reassignTask`
  - `src/state/index.ts` — `initDb`, `addAgent`, `createTask`, `getTask`, `getTasksForAgent`

---

## Test Cases

### Agent Actions

**TC-A1 — revokeAgent: happy path**
1. Add agent `wk-01` with role `worker`, room `alpha`, tmux_target `%1`.
2. Create a task assigned to `wk-01` with status `active`.
3. Stub `paneExists('%1')` → `true`, `sendEscape` → resolves.
4. Call `revokeAgent('wk-01')`.
5. Expected:
   - Returns string containing `"Revoked wk-01"`.
   - Task status in DB is `interrupted`.
   - `getAgent('wk-01')` returns `null` (agent removed from all rooms).

**TC-A2 — revokeAgent: agent not found**
1. Call `revokeAgent('ghost')` with no such agent in DB.
2. Expected: throws `Error` with message containing `"ghost"`.

**TC-A3 — interruptAgent: happy path**
1. Add agent `wk-02`, tmux_target `%2`.
2. Create active task for `wk-02`.
3. Stub `paneExists('%2')` → `true`.
4. Call `interruptAgent('wk-02')`.
5. Expected:
   - Returns string containing `"Interrupted wk-02"` and the task id.
   - Task status in DB is `interrupted`, `interrupted_by` is `"dashboard"`.
   - Agent record still exists (not removed).

**TC-A4 — interruptAgent: no active task**
1. Add agent `wk-03` with no active tasks.
2. Call `interruptAgent('wk-03')`.
3. Expected: throws error mentioning `"no active task"`.

**TC-A5 — interruptAgent: pane is dead**
1. Add agent `wk-04` with an active task.
2. Stub `paneExists('%4')` → `false`.
3. Call `interruptAgent('wk-04')`.
4. Expected: throws error mentioning `"pane is dead"`.

**TC-A6 — clearAgentSession: happy path**
1. Add agent `wk-05`, tmux_target `%5`.
2. Stub `paneExists('%5')` → `true`. Capture `sendKeys` calls.
3. Call `clearAgentSession('wk-05')`.
4. Expected:
   - Returns string containing `"Cleared wk-05 session"`.
   - `sendKeys` called twice: first with `"/clear"`, then with `"/crew:refresh --name wk-05"`.

**TC-A7 — clearAgentSession: pane is dead**
1. Add agent `wk-06`, stub `paneExists` → `false`.
2. Expected: throws error mentioning `"pane is dead"`.

---

### Task Actions

**TC-T1 — interruptTask: happy path**
1. Add agent `wk-01`, create task (status `active`) assigned to `wk-01`.
2. Fetch full task object via `getTask(id)`.
3. Stub `sendEscape` → resolves.
4. Call `interruptTask(task)`.
5. Expected:
   - Returns string with `"Interrupted task #<id>"`.
   - `getTask(id).status` is `interrupted`.

**TC-T2 — interruptTask: wrong status**
1. Create task with status `queued`.
2. Call `interruptTask(task)`.
3. Expected: throws error containing `"must be \"active\""`.

**TC-T3 — cancelTask: happy path**
1. Create task with status `queued`.
2. Call `cancelTask(task)`.
3. Expected:
   - Returns string with `"Cancelled task #<id>"`.
   - `getTask(id).status` is `cancelled`.

**TC-T4 — cancelTask: wrong status (active)**
1. Create task with status `active`.
2. Call `cancelTask(task)`.
3. Expected: throws error containing `"must be \"queued\""`.

**TC-T5 — reassignTask from active**
1. Add agent `wk-01`, create active task for `wk-01`.
2. Stub `sendEscape` and capture `sendKeys` calls.
3. Call `reassignTask(task, 'new task text')`.
4. Expected:
   - Old task status is `interrupted`.
   - A new task is created in DB assigned to `wk-01` with the new text.
   - `sendKeys` called with `"new task text"`.
   - Return string contains old id and new id.

**TC-T6 — reassignTask from queued**
1. Create queued task for `wk-01`.
2. Stub `sendKeys`.
3. Call `reassignTask(task, 'revised text')`.
4. Expected:
   - Old task status is `cancelled`.
   - New task created with `"revised text"`.

---

## Implementation Notes

### Script location
`test/uat-dashboard-controls.ts`

### Pattern
Follow `test/uat-sqlite.ts`: use an `assert(condition, label)` helper, tally pass/fail,
print summary at the end, `process.exit(1)` if any failures.

### Mocking tmux
The cleanest approach is to monkey-patch the module exports before importing the action
modules. With Bun, use a local mock object passed via a test-only seam, or use
`jest.mock`-style patching. Alternatively, run with a real tmux session if one is available
and use a dummy pane — but mock is preferred for CI.

Example seam pattern (if the action files read from a shared tmux module object):
```ts
import * as tmux from '../src/tmux/index.ts';
(tmux as any).paneExists = async () => true;
(tmux as any).sendEscape = async () => {};
(tmux as any).sendKeys = async (_t: string, _k: string) => { keyCalls.push(_k); };
```

### DB isolation
Call `initDb(':memory:')` at the start of each logical test group, `closeDb()` after.
Or use a temp file path per test to avoid the singleton issue.

### Running
```
bun test/uat-dashboard-controls.ts
```
