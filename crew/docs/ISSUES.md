# Known Issues

## Workers don't acknowledge task completion (Haiku model)

**Status:** Open
**Severity:** Medium — requires manual nudging, wastes leader polling cycles
**Reported:** 2026-04-12

### Problem

Workers running on Haiku model complete coding tasks but fail to report back via `send_message` (completion) or `update_task`. They go idle silently, forcing the leader to poll `get_status` and guess whether the task finished.

### Root Causes

1. **Haiku doesn't follow multi-step protocols reliably.** The worker skill requires: receive task -> `update_task(active)` -> do work -> `send_message(completion)` -> `update_task(completed)`. Haiku focuses on the coding and skips the bookkeeping.

2. **No automatic acknowledgment in code.** Task acknowledgment is entirely voluntary — the worker model must call crew tools after finishing. If it doesn't, the system has no fallback.

3. **Stale queue confusion.** Workers with many old "sent" tasks get confused by "IGNORE ALL OLD MESSAGES" instructions. Haiku is more susceptible to processing stale tasks or getting overwhelmed.

### Workarounds

- Use Sonnet or Opus for workers (better protocol adherence)
- End task descriptions with explicit reminder: "When done: send_message to lead-01 with kind completion"
- Leader nudges idle workers immediately (don't wait)

### Proposed Fixes

- **Auto-acknowledge:** When a task is pushed to a pane, auto-mark it "active" server-side instead of relying on the worker to call `update_task`
- **Completion detection:** If worker goes busy->idle and has an active task, auto-mark task as completed and notify the leader
- **Queue cleanup tool:** `clear_worker_session` is available via CLI (`crew clear-session`). Clear stale queues before assigning new tasks.

---

## Stale agent registrations persist after pane reuse

**Status:** Fixed (2026-04-12)
**Severity:** Medium — dashboard shows phantom agents

### Problem

When a worker re-registers with a new name on the same tmux pane, the old agent registration persists in the DB. Dashboard shows both the stale and current agent as active.

### Root Cause

`join_room` checked for same-name collisions but not same-pane collisions. The liveness sweep couldn't catch these because the pane IS alive — just owned by a different agent name.

### Fix

Commit `67d651f`: `join_room` now evicts any existing agent on the same pane before registering the new one. Combined with `8ff96e9` (same-name overwrite for dead panes), both collision types are handled.
