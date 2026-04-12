# UAT Plan: Polling Cost Reduction — check_changes (Task 6)

## Goal

Verify that `check_changes` returns correct version numbers per scope, that versions
increment when state mutates, and that the response payload is dramatically smaller than
the full `read_messages` / `get_status` responses — confirming the cost-reduction promise.

---

## Prerequisites

- `initDb(':memory:')` (or a temp file, cleaned per test)
- At least one agent and room seeded before each test
- Imports:
  - `src/tools/check-changes.ts` — `handleCheckChanges`
  - `src/tools/read-messages.ts` — `handleReadMessages`
  - `src/tools/get-status.ts` — `handleGetStatus`
  - `src/state/index.ts` — `initDb`, `closeDb`, `addAgent`, `addMessage`, `createTask`,
    `updateTaskStatus`, `getChangeVersions`

---

## Test Cases

### Version correctness

**TC-V1 — All three scopes present on fresh DB**
1. `initDb(':memory:')`.
2. Call `handleCheckChanges({ name: 'lead-01', scopes: ['messages', 'tasks', 'agents'] })`.
3. Expected:
   - Result is `ok(...)` (no error).
   - `result.scopes` contains keys `messages`, `tasks`, `agents`.
   - Each entry has `{ version: number, updated_at: string }`.

**TC-V2 — messages version bumps on new message**
1. Record baseline: `v1 = result.scopes.messages.version`.
2. Call `addMessage(...)` to post one message in the room.
3. Call `handleCheckChanges` again.
4. Expected: `v2 > v1` for `messages`; `tasks` and `agents` versions unchanged.

**TC-V3 — tasks version bumps on task create**
1. Record baseline versions for all scopes.
2. Call `createTask(room, agent, 'lead-01', null, 'do something')`.
3. Call `handleCheckChanges`.
4. Expected: `tasks.version` incremented; `messages` and `agents` unchanged.

**TC-V4 — tasks version bumps on task status update**
1. Create a task, record baseline `tasks.version`.
2. Call `updateTaskStatus(id, 'active')`.
3. Call `handleCheckChanges`.
4. Expected: `tasks.version` incremented again.

**TC-V5 — agents version bumps on agent join**
1. Record baseline `agents.version`.
2. Call `addAgent('new-wk', 'worker', 'alpha', '%9')`.
3. Call `handleCheckChanges`.
4. Expected: `agents.version` incremented.

**TC-V6 — scope filtering: only requested scopes returned**
1. Call `handleCheckChanges({ name: 'lead-01', scopes: ['tasks'] })`.
2. Expected: `result.scopes` has only key `tasks`; no `messages` or `agents` keys.

**TC-V7 — invalid scopes silently ignored**
1. Call `handleCheckChanges({ name: 'lead-01', scopes: ['tasks', 'nonexistent'] })`.
2. Expected: returns successfully; `result.scopes` has only `tasks`; no error.

**TC-V8 — default scopes (omit scopes param)**
1. Call `handleCheckChanges({ name: 'lead-01' })` — no `scopes` field.
2. Expected: all three scopes (`messages`, `tasks`, `agents`) are returned.

---

### Cost reduction (payload size)

**TC-C1 — check_changes output is smaller than read_messages**
1. Seed the room with 20 messages.
2. Measure byte length of `JSON.stringify(handleCheckChanges result)`.
3. Measure byte length of `JSON.stringify(handleReadMessages result)`.
4. Expected: `check_changes` payload < `read_messages` payload by at least 10x.

**TC-C2 — check_changes output is smaller than get_status**
1. Seed DB with 5 agents and 10 tasks across multiple rooms.
2. Measure byte length of `JSON.stringify(handleCheckChanges result)`.
3. Measure byte length of `JSON.stringify(handleGetStatus result)`.
4. Expected: `check_changes` payload < `get_status` payload by at least 5x.

**TC-C3 — Stable version means leader can skip expensive calls**
1. Record versions with `handleCheckChanges`.
2. Do NOT mutate any state.
3. Call `handleCheckChanges` again.
4. Expected: all three version numbers are identical to step 1.
5. Implication: a leader comparing snapshots can safely skip `read_messages` / `get_status`.

---

## Implementation Notes

### Script location
`test/uat-polling-cost-reduction.ts`

### Pattern
Same `assert(condition, label)` helper and pass/fail tally as `test/uat-sqlite.ts`.
Print byte-size comparison numbers for TC-C1 and TC-C2 even on pass, so the reduction
is visible in CI output.

### Measuring payload size
```ts
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
```

### DB isolation
`initDb(':memory:')` + `closeDb()` around each test group, or use a fresh temp file per
group. The `:memory:` approach is fastest.

### Running
```
bun test/uat-polling-cost-reduction.ts
```
