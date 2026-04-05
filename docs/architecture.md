# cc-tmux Architecture

cc-tmux is a Claude Code plugin (MCP server + skills) that lets Claude Code agents coordinate with each other via tmux rooms.

## Design Philosophy

**Registration-first, coordination hub, smart agents.**

- Agents register themselves into rooms via slash commands
- The MCP server is a coordination hub, not a session manager
- tmux `send-keys` is the push delivery transport
- Dual-mode messaging: push (interrupt) + pull (queue)

## Hierarchy

```
Boss (company room) — the human's CC session
├── Leader-1 (company room + project-alpha room)
│   ├── Worker-1 (project-alpha room)
│   └── Worker-2 (project-alpha room)
└── Leader-2 (company room + project-beta room)
    └── Worker-3 (project-beta room)
```

## Core MCP Tools (7)

| Tool | Purpose |
|------|---------|
| `join_room` | Register agent in a room with role + name |
| `leave_room` | Deregister from a room |
| `list_rooms` | List active rooms with member counts |
| `list_members` | List agents in a room |
| `send_message` | Send push or pull message to agent/room |
| `read_messages` | Read from agent's inbox queue |
| `get_status` | Check agent status (idle/busy/dead) |

## Module Structure

```
src/
├── index.ts          # MCP server entrypoint
├── tools/            # One file per MCP tool
├── tmux/             # Thin tmux CLI wrapper (send-keys, capture-pane)
├── state/            # Rooms, registry, message queues (file-backed JSON)
└── delivery/         # Push (tmux) + pull (queue) delivery logic
```

## Key Technical Decisions

- **Runtime:** Bun (native TS, no build step)
- **State:** File-backed JSON in `/tmp/cc-tmux/state/`
- **Push delivery:** `tmux send-keys -l` (literal mode) + separate Enter
- **Status detection:** Regex on CC's status line from `capture-pane` output
- **ANSI stripping:** `strip-ansi` applied to all capture-pane output
- **No background polling:** All detection is on-demand

## CC Status Line Patterns (empirically validated)

- **Idle:** Empty `❯` prompt between separator lines
- **Busy:** Spinner char (`·`, `*`, `✶`, `✽`, `✻`) + verb + `…` + timer
- **Complete:** `✻ {Verb} for {time}` (e.g. "Baked for 1m 2s")
- **Dead:** `#{pane_dead}` via `tmux list-panes -F`

## Planning Artifacts

Full design documents in `_bmad-output/`:
- `brainstorming/brainstorming-session-2026-04-05-1500.md` — Architecture decisions
- `planning-artifacts/prd.md` — Product Requirements (34 FRs, 14 NFRs)
- `planning-artifacts/architecture.md` — Formal architecture document
- `planning-artifacts/epics.md` — 7 epics, 20 stories for MVP
- `test-artifacts/uat-tmux-primitives.md` — UAT test results
