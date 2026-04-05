---
stepsCompleted: [1, 2, 3, 4]
inputDocuments: ['_bmad-output/session-report.md']
session_topic: 'cc-tmux TUI observation dashboard: real-time terminal UI for monitoring rooms, agents, status, and message flow'
session_goals: '1) Information architecture — what to display 2) Layout design — panels, splits, hierarchy 3) Interaction model — read-only vs command-capable 4) TUI framework choice 5) Update mechanism — how to get live data 6) Packaging — relationship to MCP server'
selected_approach: 'ai-recommended'
techniques_used: ['morphological-analysis', 'first-principles-thinking', 'scenario-walkthrough']
ideas_generated: [35]
context_file: '_bmad-output/session-report.md'
technique_execution_complete: true
---

# cc-tmux TUI Dashboard — Design Document

**Author:** lee
**Date:** 2026-04-05
**Status:** Design complete, ready for PRD/architecture

---

## Core Design Philosophy

**Passive observer, zero deps, file-driven.** The TUI dashboard is a read-only terminal UI that watches cc-tmux state files and tmux panes to give the human boss a single-pane control room view of all agent activity. It has no connection to the MCP server — it reads the same JSON files agents write to, and shells out to tmux for live status detection.

**Three principles:**
1. **Read-only for v1** — the boss has their own CC session for commands; the dashboard is for situational awareness
2. **Raw ANSI with Bun** — zero dependencies beyond what cc-tmux already has; same runtime, same repo
3. **File-driven updates** — fs.watch on state files + batch tmux capture-pane every 2 seconds

---

## Morphological Analysis Decisions

| Dimension | Decision | Rationale |
|---|---|---|
| **Information** | Split view: hierarchy tree + live message feed, agent status inline | Tree gives structure, feed gives real-time activity |
| **Layout** | 3-panel: tree (left), messages (right-top), details (right-bottom) | Maps naturally to the data model |
| **Interaction** | Read-only observer for v1 | Boss has their own CC session; adding commands creates complexity |
| **Framework** | Raw ANSI with Bun, zero deps | Same runtime as MCP server; ink pulls React which is heavy for a log viewer |
| **Updates** | fs.watch + batch tmux capture-pane every 2s | Simplest, works with existing architecture, no MCP server changes |
| **Packaging** | Subcommand in same repo: `cc-tmux dashboard` or `bun run src/dashboard.ts` | One package, one install |

---

## Layout Design

### 3-Panel Layout (Alternate Screen Buffer)

```
┌─ Rooms & Agents ──────────┐┌─ Messages ─────────────────────────┐
│                            ││                                     │
│ ▼ company (3)              ││ 14:32:01 [boss@company] → lead-1   │
│   ● boss        idle       ││   Build the auth system             │
│   ● lead-1      busy       ││                                     │
│                            ││ 14:32:15 [lead-1@frontend] → ALL   │
│ ▼ frontend (4)             ││   New task incoming, stand by       │
│   ● lead-1 [+company] busy ││                                     │
│   ○ builder-1   idle       ││ 14:32:18 [lead-1@frontend] → b-1   │
│   ◉ builder-2   busy       ││   Create login component in src/    │
│   ○ tester-1    idle       ││                                     │
│                            ││ 14:32:20 [lead-1@frontend] → b-2   │
│                            ││   Write auth middleware              │
│                            ││                                     │
│                            │├─ Details ────────────────────────────┤
│                            ││ Selected: lead-1                     │
│                            ││ Role: leader                         │
│                            ││ Rooms: company, frontend             │
│                            ││ Status: busy (3s)                    │
│                            ││ Pane: %101                           │
└────────────────────────────┘└─────────────────────────────────────┘
```

### Panel Specifications

**Left Panel — Room/Agent Tree:**
- Collapsible room groups with member count
- Agent listed under PRIMARY room (first room joined)
- Multi-room agents show badge: `lead-1 [+company]`
- No duplicates — agent appears once
- Status inline: colored `●` circle + status text
- Arrow key navigation (up/down to select agent)
- Selected agent highlighted, updates details panel

**Right-Top Panel — Message Feed:**
- All rooms mixed, chronological (newest at bottom)
- Color-coded room names for differentiation
- Format: `HH:MM:SS [sender@room] → target: text`
- Broadcast shown as `→ ALL`
- Scrolls automatically, keeps last N messages visible
- No filtering for v1 — full situational awareness

**Right-Bottom Panel — Details:**
- Shows selected agent's full info
- Role, all rooms, current status, tmux pane ID, last activity timestamp
- Auto-selects most recently changed agent by default
- Arrow key selection in tree overrides auto-select

### Status Indicators

| Status | Color | Symbol | Example |
|---|---|---|---|
| Idle | Green | `●` | `● builder-1   idle` |
| Busy | Yellow | `●` | `● lead-1      busy` |
| Dead | Red | `●` | `● builder-2   dead` |
| Unknown | Gray | `●` | `● tester-1    unknown` |

Terminal colors are universal. `●` (U+25CF) for all states — color carries the meaning.

---

## First Principles Decisions

### Build Order (Bottom-Up)

1. **Status list** — batch tmux capture-pane for all agents, parse status, display simple list
2. **Tree layout** — rooms with collapsible agent groups, keyboard nav
3. **Message feed** — read messages.json, render chronological feed
4. **Details panel** — agent detail view on selection
5. **Polish** — box drawing, resize handling, auto-select

### Rendering Strategy

- **Full redraw** every poll cycle on alternate screen buffer (`\x1b[?1049h`)
- No diff-based updates — at 2s intervals, flicker is a non-issue
- If flicker occurs, add double-buffering (write to string, flush once) — but unlikely
- Handle `SIGWINCH` for terminal resize: recalculate panel dimensions, redraw

### Status Polling Strategy

- **Batch all panes** in one sweep every 2 seconds
- 10-20 agents = 10-20 `capture-pane` calls = <500ms total
- Don't stagger — batch, update display, wait, repeat
- Use `Bun.spawn()` for tmux commands (same as MCP server)

### File Read Safety

- **MCP server writes:** Write to temp file, then `rename()` (atomic on Linux/macOS)
- **Dashboard reads:** Try JSON.parse, retry once on error, show last known state if both fail
- Dashboard and MCP server never coordinate — fully decoupled

---

## Scenario Validations

### Scenario 1: Boot and Monitor

Alex has 5 agents across 2 rooms. Opens `cc-tmux dashboard` in a new tmux pane.

- Dashboard reads `agents.json` and `rooms.json` → builds tree
- Batch captures all 5 panes → populates status
- Reads `messages.json` → populates feed
- Full redraw → 3-panel layout appears
- Auto-selects most recently active agent
- Every 2s: re-batch status, re-read files, redraw

**Validated:** Dashboard starts cold from files, no handshake with MCP server needed.

### Scenario 2: Worker Dies Mid-Task

builder-2 crashes. Its tmux pane dies.

- Next 2s cycle: `capture-pane` fails, `#{pane_dead}` returns true
- Tree: `● builder-2 busy` → `● builder-2 dead` (turns red)
- Auto-selects builder-2 (most recently changed)
- Details: `Status: dead | Last seen: busy (14:32:45) | Pane: %103 (dead)`
- Boss sees red in their peripheral vision, switches to their CC session to handle it

**Validated:** Death detection is passive through normal poll cycle. No events needed.

### Scenario 3: MCP Server Restarts

Server crashes mid-operation. Boss restarts it.

- Dashboard reads files independently — doesn't connect to server
- If server crashed mid-write: JSON parse fails → retry → show "state unavailable", keep last known state
- Server restarts, reloads state, validates liveness → files update
- Dashboard picks up new state on next 2s poll
- Agents that re-register appear fresh; dead agents shown red

**Validated:** Dashboard is fully decoupled from server lifecycle. Server crashes visible as stale data, not dashboard crashes.

---

## Architecture Summary

### Data Flow

```
/tmp/cc-tmux/state/agents.json ──┐
/tmp/cc-tmux/state/rooms.json  ──┼── fs.watch ──→ Dashboard reads JSON
/tmp/cc-tmux/state/messages.json ┘
                                    
tmux capture-pane (per agent) ──────→ Dashboard polls every 2s
                                    
Dashboard ──→ alternate screen buffer ──→ terminal
```

### Project Structure (within cc-tmux repo)

```
src/
├── dashboard.ts            # Dashboard entrypoint
├── dashboard/
│   ├── app.ts              # Main loop: poll, read, render
│   ├── render.ts           # ANSI rendering: panels, tree, feed
│   ├── tree.ts             # Room/agent tree data structure + nav
│   ├── feed.ts             # Message feed formatting
│   ├── status.ts           # Batch tmux capture-pane + status parse
│   └── terminal.ts         # Raw terminal: alternate screen, resize, cursor, colors
└── ...existing MCP server files...
```

### Shared Code with MCP Server

- **Status regex patterns** — same CC idle/busy/dead patterns from `src/tmux/index.ts`
- **State file types** — same TypeScript interfaces for agents.json, rooms.json, messages.json
- **tmux wrapper** — reuse `capturePane()`, `isPaneDead()` from `src/tmux/index.ts`

### Launch

```bash
# From cc-tmux plugin directory
bun run src/dashboard.ts

# Or as a package.json script
bun run dashboard
```

---

## Open Questions for Implementation

1. **Panel width ratios** — Fixed 30/70 split or configurable? Start with fixed.
2. **Message feed buffer** — How many messages to keep in memory? Last 500? Configurable?
3. **Tree collapse state** — Remember which rooms are collapsed? Or always expanded?
4. **Color theme** — Hardcoded dark theme or detect terminal background?
5. **Quit key** — `q` to quit? `Ctrl+C`? Both?

---

## Design Evolution Notes

This design emerged from a brainstorming session using Morphological Analysis (6-dimension grid), First Principles Thinking (build order, rendering, polling, safety), and Scenario Walkthrough (boot, death, restart). Key insight: the dashboard is architecturally simpler than it looks — it's a file reader + tmux poller + ANSI renderer. No IPC, no events, no framework. The complexity is in the rendering, not the data.
