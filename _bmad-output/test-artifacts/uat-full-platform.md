# UAT: Full cc-tmux Platform — Real tmux Integration

**Date**: 2026-04-06
**Environment**: Default tmux server, Bun 1.3.8, tmux 3.5a
**Test session**: `uat-cctmux` (3 panes: %278 boss, %279 leader, %280 worker)

## Summary

| Category | Tests | Pass | Fail |
|----------|-------|------|------|
| Agent Registration | 7 | 7 | 0 |
| Room Listing | 3 | 3 | 0 |
| Push Messaging | 4 | 4 | 0 |
| Pull Messaging + Read | 4 | 4 | 0 |
| Status Detection | 2 | 2 | 0 |
| State Persistence | 4 | 4 | 0 |
| Leave Room | 3 | 3 | 0 |
| **Total** | **27** | **27** | **0** |

Plus: TUI Dashboard visual UAT (delegated to tmux agent) — **PASS**

## UAT #1: Agent Registration

| Test | Result | Notes |
|------|--------|-------|
| Boss joins company room | PASS | `ceo` registered with `tmux_target: %278` |
| Leader joins company room | PASS | `lead-frontend` with `tmux_target: %279` |
| Leader joins second room (multi-room) | PASS | Same agent in both `company` and `frontend` |
| Worker joins project room | PASS | `builder-1` with `tmux_target: %280` |
| Duplicate name rejection | PASS | `builder-1` in `frontend` rejected |
| Invalid role rejection | PASS | `admin` role rejected |
| Invalid pane rejection | PASS | `%99999` (non-existent) rejected |

## UAT #2: Room Listing

| Test | Result | Notes |
|------|--------|-------|
| list_rooms shows both rooms | PASS | company (2 members), frontend (2 members) |
| list_members company | PASS | `[ceo, lead-frontend]` |
| list_members frontend | PASS | `[builder-1, lead-frontend]` |

## UAT #3: Push Messaging (tmux send-keys)

| Test | Result | Notes |
|------|--------|-------|
| Boss → leader direct push | PASS | `[ceo@company]: Build the auth system` appeared in leader pane |
| Leader → worker direct push | PASS | `[lead-frontend@frontend]: Implement login component` appeared in worker pane |
| Broadcast push in company room | PASS | Message delivered to lead-frontend (boss excluded from broadcast) |
| Push to non-member rejected | PASS | `builder-1` not in `company` room |

**Push format verified in tmux panes:**
```
➜  bmad git:(feat/bmad) ✗ [ceo@company]: Build the auth system
zsh: no matches found: [ceo@company]:
➜  bmad git:(feat/bmad) ✗ [ceo@company]: All hands meeting in 5 min
```

Note: `zsh: no matches found` is expected — zsh interprets brackets as glob patterns. The text IS delivered and visible. In real CC usage, the CC session reads stdin, not zsh, so this is a non-issue.

## UAT #4: Pull Messaging + Read

| Test | Result | Notes |
|------|--------|-------|
| Worker sends pull message | PASS | Queued but not delivered (no tmux send-keys) |
| Leader reads full inbox | PASS | Messages from both boss and worker present |
| Room-filtered read | PASS | Only frontend messages returned |
| Cursor-based incremental read | PASS | `since_sequence` returns only newer messages |

## UAT #5: Status Detection

| Test | Result | Notes |
|------|--------|-------|
| Live pane status | PASS | Real tmux pane detected as not-dead (status: unknown — shell prompt doesn't match CC idle pattern) |
| Dead pane detection | PASS | Non-existent pane %99998 → status: dead |

Note: Status detection correctly distinguishes live vs dead panes. The idle/busy/complete patterns are CC-specific (require CC status line), so shell panes report "unknown" — correct behavior.

## UAT #6: State Persistence

| Test | Result | Notes |
|------|--------|-------|
| State files exist | PASS | `/tmp/cc-tmux/state/{agents,rooms,messages}.json` |
| agents.json correct | PASS | All agents with roles, rooms, tmux_targets |
| rooms.json correct | PASS | Both rooms with member lists |
| messages.json correct | PASS | 5 messages with full metadata (id, from, room, to, text, timestamp, sequence, mode) |

## UAT #7: Leave Room

| Test | Result | Notes |
|------|--------|-------|
| Worker leaves room | PASS | Removed from frontend |
| Room membership updated | PASS | builder-1 no longer in frontend members |
| Multi-room agent partial leave | PASS | lead-frontend leaves company but stays in frontend |

## UAT #8: TUI Dashboard (Visual — by tmux agent)

The tmux agent (`nvim:1.0`) launched `bun run dashboard` in a separate pane and verified:

| Check | Result |
|-------|--------|
| 3-panel layout renders | PASS — box-drawing chars ┌─┐│└─┘ correct |
| Room/Agent tree | PASS — ▼ company (2), ▼ frontend (2) with members |
| Multi-room badge | PASS — `lead-frontend [+frontend]` shown |
| Message feed | PASS — 5 messages, HH:MM:SS [sender@room] → target format |
| Broadcast display | PASS — "All hands meeting" shows → ALL |
| Details panel auto-select | PASS — ghost-agent selected (most recent status change) |
| Dead status display | PASS — `Status: dead` for ghost-agent |
| Keyboard navigation | PASS — escape sequences (\x1b[B) cycle through agents |
| Multi-room in details | PASS — lead-frontend shows `Rooms: company, frontend` |
| Clean quit (q) | PASS — alternate screen exited, terminal restored |

**Note**: Raw mode dashboard requires escape sequences for navigation, not tmux named keys (Down). This is expected behavior.

## Full Test Suite

```
bun test v1.3.8
 80 pass, 0 fail, 180 expect() calls
 5 test files (state, status-patterns, tools, dashboard, uat-real)
```
